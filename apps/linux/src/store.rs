// Live client state: the chats, tasks, approvals, the desktop, pause state and spend, fed by the
// event stream. Same shape as iOS's AppStore.swift and apps/web/src/store.ts. No GTK here: views
// listen for `Change`s and read what they show.
use std::cell::{Cell, Ref, RefCell, RefMut};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::time::Duration;

use gtk::glib;
use serde::Serialize;

use crate::core::delta;
use crate::core::models::*;
use crate::core::thread;
use crate::net::api::{Api, ApiError, Empty, Result};
use crate::net::socket::{Frame, Socket};

pub const PAGE: usize = 50;

/// What changed, for the views showing it.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// Messages came, went or changed in the open chat; or another chat opened.
    Messages,
    /// A reply being written: its text, progress or usage.
    Reply(i64),
    /// The chats, bots or their unread counts.
    Chats,
    Unread,
    Task(i64),
    /// A page of the task lists came.
    Tasks,
    /// Approvals or questions waiting for you.
    NeedsYou,
    Desktop,
    Paused,
    Connection,
    Spend,
    Schedule(i64),
    Box(i64),
    Memory,
    Settings,
    Toast(String),
}

/// A reply as it's written: its text, latest progress and what it has used so far.
#[derive(Debug, Clone, Default)]
pub struct LiveReply {
    pub text: String,
    pub progress: String,
    pub usage: Option<ReplyUsage>,
}

#[derive(Default)]
pub struct State {
    /// The chat that's showing: a bot's own, or a group. Hatbot's own is the first.
    pub conversation_id: i64,
    /// The incognito conversation is showing instead of the chat. Kept while the app runs.
    pub incognito: bool,
    pub messages: Vec<ThreadMessage>,
    /// The conversations the loaded messages belong to, for their recaps.
    pub episodes: HashMap<i64, Episode>,
    pub replies: HashMap<i64, LiveReply>,
    pub has_earlier: bool,
    loading_earlier: bool,
    /// The chat that's showing has loaded once: an empty one is empty, not loading.
    pub loaded: bool,
    /// Hatbot's messages sent or edited since you last saw them, in every chat.
    pub unread: BTreeSet<i64>,
    pub paused: bool,
    pub today_usd: Option<f64>,
    pub month_usd: Option<f64>,
    pub connected: bool,
    /// The event stream has been down a few seconds.
    pub unreachable: bool,
    pub tasks: HashMap<i64, Task>,
    /// Steps of the tasks that have been opened.
    pub steps: HashMap<i64, Vec<TaskStep>>,
    pub task_files: HashMap<i64, Vec<Attachment>>,
    /// Latest progress per running task.
    pub task_progress: HashMap<i64, String>,
    pub approvals: HashMap<i64, Approval>,
    pub questions: HashMap<i64, Question>,
    pub desktop: Option<DesktopState>,
    pub schedules: HashMap<i64, Schedule>,
    /// Schedules a message points at that no longer exist.
    pub deleted_schedules: HashSet<i64>,
    pub boxes: HashMap<i64, AppBox>,
    /// Boxes a message points at that no longer exist.
    pub deleted_boxes: HashSet<i64>,
    /// Your bots, deleted ones too once seen: old messages still name them.
    pub bots: HashMap<String, Bot>,
    /// Bots that aren't deleted, Hatbot first.
    pub bot_ids: Vec<String>,
    /// Your chats: each bot's own, then groups. Empty on brains from before bots.
    pub conversations: Vec<Conversation>,
    /// Each load of the latest page in flight, with the replies' events that came meanwhile: the
    /// page may have been read before them, so they go on it again.
    missed: HashMap<u64, Vec<Event>>,
    /// Messages in an incognito conversation: they're never unread.
    incognito_ids: HashSet<i64>,
    requested: HashSet<String>,
    wanted_tasks: Vec<i64>,
    seen_queue: Vec<i64>,
    refreshing: bool,
    refresh_again: bool,
}

impl State {
    /// Approvals and questions waiting for you, plus a takeover request.
    pub fn needs_you(&self) -> usize {
        self.pending_approvals().len()
            + self.pending_questions().len()
            + usize::from(self.desktop.as_ref().is_some_and(|d| d.request.is_some()))
    }

    pub fn pending_approvals(&self) -> Vec<&Approval> {
        let mut list: Vec<_> = self
            .approvals
            .values()
            .filter(|a| a.status == ApprovalStatus::Pending)
            .collect();
        list.sort_by_key(|a| a.id);
        list
    }

    pub fn pending_questions(&self) -> Vec<&Question> {
        let mut list: Vec<_> = self
            .questions
            .values()
            .filter(|q| q.status == QuestionStatus::Pending)
            .collect();
        list.sort_by_key(|q| q.id);
        list
    }

    pub fn bot_name(&self, id: Option<&str>) -> String {
        let Some(id) = id else { return String::new() };
        self.bots
            .get(id)
            .map(|b| b.name.clone())
            .unwrap_or_else(|| {
                if id == HATBOT_ID {
                    "Hatbot".into()
                } else {
                    id.into()
                }
            })
    }

    /// A group's title, or its bot's name.
    pub fn chat_name(&self, c: Option<&Conversation>) -> String {
        let Some(c) = c else { return "Hatbot".into() };
        if c.kind == ConversationKind::Group {
            return c.title.clone().unwrap_or_else(|| {
                c.bot_ids
                    .iter()
                    .map(|b| self.bot_name(Some(b)))
                    .collect::<Vec<_>>()
                    .join(", ")
            });
        }
        self.bot_name(c.bot_ids.first().map(String::as_str))
    }

    pub fn current_chat(&self) -> Option<&Conversation> {
        self.conversations
            .iter()
            .find(|c| c.id == self.conversation_id)
    }

    /// A message's text as it is now: a streaming reply's is in its live reply.
    pub fn text<'a>(&'a self, m: &'a ThreadMessage) -> &'a str {
        match (m.status, self.replies.get(&m.id)) {
            (MessageStatus::Streaming, Some(r)) => &r.text,
            _ => &m.text,
        }
    }

    /// The chat's API path; a brain from before bots has only the one, /thread.
    fn chat_path(&self) -> String {
        if self.conversations.is_empty() {
            "/thread".into()
        } else {
            format!("/conversations/{}", self.conversation_id)
        }
    }

    fn page(&self, before: Option<i64>) -> String {
        let mut path = format!("{}/messages?limit={PAGE}", self.chat_path());
        if let Some(b) = before {
            path += &format!("&before={b}");
        }
        if self.incognito {
            path += "&incognito=1";
        }
        path
    }

    fn shows(&self, m: &ThreadMessage) -> bool {
        m.incognito == self.incognito && m.conversation_id == self.conversation_id
    }

    fn index(&self, id: i64) -> Option<usize> {
        self.messages.iter().position(|m| m.id == id)
    }

    /// A message gets its conversation after it's posted; the POST's answer can land after that
    /// news and mustn't take it away again, or the message files under the fold before it.
    fn upsert(&mut self, mut m: ThreadMessage) {
        if let Some(i) = self.index(m.id) {
            m.episode_id = m.episode_id.or(self.messages[i].episode_id);
            self.messages[i] = m;
        } else {
            let at = self.messages.partition_point(|x| x.id < m.id);
            self.messages.insert(at, m);
        }
    }

    /// The live reply for a streaming message, made for one loaded mid-reply.
    fn live(&mut self, id: i64) -> Option<&mut LiveReply> {
        if !self.replies.contains_key(&id) {
            let i = self.index(id)?;
            if self.messages[i].status != MessageStatus::Streaming {
                return None;
            }
            let text = self.messages[i].text.clone();
            self.replies.insert(
                id,
                LiveReply {
                    text,
                    ..Default::default()
                },
            );
        }
        self.replies.get_mut(&id)
    }

    /// What a reply's own events do to its text and state, also on a page read before they came:
    /// a delta adds only what the reply doesn't have yet.
    fn follow(&mut self, event: &Event) -> Option<Change> {
        match event {
            Event::MessageRewrite { id } => {
                // Its task ended: its bot is writing it again.
                let i = self.index(*id)?;
                self.replies.insert(*id, LiveReply::default());
                self.messages[i].text.clear();
                self.messages[i].status = MessageStatus::Streaming;
                Some(Change::Messages)
            }
            Event::MessageDelta { id, text, at } => {
                let r = self.live(*id)?;
                r.text = delta::added(text, &r.text, *at);
                Some(Change::Reply(*id))
            }
            Event::MessageDone {
                id,
                text,
                status,
                sources,
                choices,
            } => {
                self.replies.remove(id);
                let i = self.index(*id)?;
                let m = &mut self.messages[i];
                m.text = text.clone();
                m.status = *status;
                if let Some(s) = sources {
                    m.sources = s.clone();
                }
                if let Some(c) = choices {
                    m.choices = c.clone();
                }
                Some(Change::Messages)
            }
            _ => None,
        }
    }

    /// After loading the latest page: its streaming replies start again from the brain's text.
    fn sync_replies(&mut self, page: &[ThreadMessage]) {
        for m in page {
            if m.status != MessageStatus::Streaming {
                self.replies.remove(&m.id);
            } else {
                self.replies.entry(m.id).or_default().text = m.text.clone();
            }
        }
        let shown: HashSet<i64> = self.messages.iter().map(|m| m.id).collect();
        self.replies.retain(|id, _| shown.contains(id));
    }

    fn add_unread(&mut self, id: i64) -> bool {
        !self.incognito_ids.contains(&id) && self.unread.insert(id)
    }
}

#[derive(Clone)]
pub struct Store(Rc<Inner>);

type ListenerFn = Rc<dyn Fn(&Change)>;

pub struct Inner {
    pub api: Api,
    state: RefCell<State>,
    stream: RefCell<Option<Socket>>,
    listeners: RefCell<Vec<(u64, ListenerFn)>>,
    next_id: Cell<u64>,
    unreachable_check: RefCell<Option<glib::JoinHandle<()>>>,
    seen_flush: Cell<bool>,
    /// How long the chats wait for the rest of a burst of news before they load.
    pub refresh_delay: Cell<Duration>,
}

/// Something listening for changes; it stops when dropped.
pub struct Listener(Weak<Inner>, u64);

impl Drop for Listener {
    fn drop(&mut self) {
        if let Some(s) = self.0.upgrade() {
            s.listeners.borrow_mut().retain(|(id, _)| *id != self.1);
        }
    }
}

impl Store {
    pub fn new(api: Api) -> Store {
        let state = State {
            conversation_id: 1,
            ..Default::default()
        };
        Store(Rc::new(Inner {
            api,
            state: RefCell::new(state),
            stream: RefCell::new(None),
            listeners: RefCell::new(vec![]),
            next_id: Cell::new(0),
            unreachable_check: RefCell::new(None),
            seen_flush: Cell::new(false),
            refresh_delay: Cell::new(Duration::from_millis(300)),
        }))
    }

    pub fn api(&self) -> &Api {
        &self.0.api
    }

    pub fn state(&self) -> Ref<'_, State> {
        self.0.state.borrow()
    }

    fn state_mut(&self) -> RefMut<'_, State> {
        self.0.state.borrow_mut()
    }

    fn weak(&self) -> Weak<Inner> {
        Rc::downgrade(&self.0)
    }

    fn from_weak(weak: &Weak<Inner>) -> Option<Store> {
        weak.upgrade().map(Store)
    }

    /// Calls `f` with every change until the returned listener is dropped.
    #[must_use]
    pub fn listen(&self, f: impl Fn(&Change) + 'static) -> Listener {
        let id = self.0.next_id.get() + 1;
        self.0.next_id.set(id);
        self.0.listeners.borrow_mut().push((id, Rc::new(f)));
        Listener(self.weak(), id)
    }

    /// A line at the bottom of the window.
    pub fn toast(&self, text: &str) {
        self.emit(Change::Toast(text.into()));
    }

    fn emit(&self, change: Change) {
        let listeners: Vec<_> = self
            .0
            .listeners
            .borrow()
            .iter()
            .map(|(_, f)| f.clone())
            .collect();
        for f in listeners {
            f(&change);
        }
    }

    /// Runs `fut` on the main loop with the store, if it's still there by then.
    fn spawn<F, Fut>(&self, f: F)
    where
        F: FnOnce(Store) -> Fut + 'static,
        Fut: std::future::Future<Output = ()> + 'static,
    {
        glib::spawn_future_local(f(self.clone()));
    }

    // Event stream

    pub fn connect(&self) {
        if self.0.stream.borrow().is_none() {
            self.0.stream.replace(Some(self.make_stream()));
        }
        if let Some(s) = self.0.stream.borrow().as_ref() {
            s.start();
        }
        self.notice_if_down();
    }

    /// Signed out or quitting: the stream stops.
    pub fn disconnect(&self) {
        if let Some(s) = self.0.stream.borrow().as_ref() {
            s.stop();
        }
        if let Some(c) = self.0.unreachable_check.take() {
            c.abort();
        }
        let mut st = self.state_mut();
        st.connected = false;
        st.unreachable = false;
    }

    /// "Can't reach Hatbot." only after a few seconds: a reconnect is usually quicker.
    fn notice_if_down(&self) {
        if let Some(c) = self.0.unreachable_check.take() {
            c.abort();
        }
        let weak = self.weak();
        let check = glib::spawn_future_local(async move {
            glib::timeout_future(Duration::from_secs(4)).await;
            let Some(s) = Store::from_weak(&weak) else {
                return;
            };
            let running = s.0.stream.borrow().as_ref().is_some_and(Socket::running);
            if s.state().connected || !running {
                return;
            }
            s.state_mut().unreachable = true;
            s.emit(Change::Connection);
        });
        self.0.unreachable_check.replace(Some(check));
    }

    fn make_stream(&self) -> Socket {
        let socket = Socket::new(&self.0.api, "/stream", 30);
        let weak = self.weak();
        socket.on_open(move |reconnected| {
            let Some(s) = Store::from_weak(&weak) else {
                return;
            };
            if let Some(c) = s.0.unreachable_check.take() {
                c.abort();
            }
            {
                let mut st = s.state_mut();
                st.connected = true;
                st.unreachable = false;
            }
            s.emit(Change::Connection);
            // Side by side: neither waits on the other.
            s.spawn(move |s| async move {
                let thread = async {
                    if reconnected {
                        let _ = s.load_thread().await;
                    }
                };
                let _ = futures_util::join!(thread, s.load_live());
            });
        });
        let weak = self.weak();
        socket.on_frame(move |frame| {
            let (Some(s), Frame::Text(text)) = (Store::from_weak(&weak), frame) else {
                return;
            };
            s.apply(Event::parse(&text));
        });
        let weak = self.weak();
        socket.on_close(move |()| {
            let Some(s) = Store::from_weak(&weak) else {
                return;
            };
            s.state_mut().connected = false;
            s.emit(Change::Connection);
            s.notice_if_down();
        });
        socket
    }

    pub fn apply(&self, event: Event) {
        let mut changes = vec![];
        let mut refresh = false;
        {
            let mut st = self.state_mut();
            // An older brain's delta doesn't say where it goes, so it can't tell whether the page has it.
            if matches!(
                event,
                Event::MessageRewrite { .. }
                    | Event::MessageDelta { at: Some(_), .. }
                    | Event::MessageDone { .. }
            ) {
                for list in st.missed.values_mut() {
                    list.push(event.clone());
                }
            }
            match event {
                Event::MessageCreated { message: m } => {
                    if m.incognito {
                        st.incognito_ids.insert(m.id);
                    }
                    let assistant = m.role == Role::Assistant;
                    refresh = assistant;
                    // What came of your own command arrives already seen.
                    if assistant
                        && m.status != MessageStatus::Streaming
                        && m.seen_at.is_none()
                        && st.add_unread(m.id)
                    {
                        changes.push(Change::Unread);
                    }
                    if st.shows(&m) {
                        if m.status == MessageStatus::Streaming && !st.replies.contains_key(&m.id) {
                            st.replies.insert(
                                m.id,
                                LiveReply {
                                    text: m.text.clone(),
                                    ..Default::default()
                                },
                            );
                        }
                        st.upsert(m);
                        changes.push(Change::Messages);
                    }
                }
                Event::MessageEdited { id, edited_at } => {
                    if let Some(i) = st.index(id) {
                        st.messages[i].edited_at = Some(edited_at);
                        changes.push(Change::Messages);
                    }
                    if st.add_unread(id) {
                        changes.push(Change::Unread);
                    }
                    refresh = true;
                }
                ref e @ (Event::MessageRewrite { .. } | Event::MessageDelta { .. }) => {
                    changes.extend(st.follow(e));
                }
                ref e @ Event::MessageDone { id, .. } => {
                    changes.extend(st.follow(e));
                    if st.add_unread(id) {
                        changes.push(Change::Unread);
                    }
                    refresh = true;
                }
                Event::MessageSeen { ids, seen_at } => {
                    for m in st.messages.iter_mut().filter(|m| ids.contains(&m.id)) {
                        m.seen_at = Some(seen_at.clone());
                    }
                    st.unread.retain(|id| !ids.contains(id));
                    changes.push(Change::Unread);
                    refresh = true;
                }
                Event::MessageDeleted { ids } => {
                    for id in &ids {
                        st.replies.remove(id);
                    }
                    st.messages.retain(|m| !ids.contains(&m.id));
                    st.unread.retain(|id| !ids.contains(id));
                    changes.extend([Change::Messages, Change::Unread]);
                }
                Event::MessageProgress { id, text } => {
                    if let Some(r) = st.live(id) {
                        r.progress = last_chars(&(r.progress.clone() + &text), 400);
                        changes.push(Change::Reply(id));
                    }
                }
                Event::MessageTask { id, task_id } => {
                    if let Some(i) = st.index(id) {
                        st.messages[i].task_id = Some(task_id);
                        changes.push(Change::Messages);
                    }
                }
                Event::MessageLinked { id, link } => {
                    if let Some(i) = st.index(id) {
                        st.messages[i].link = Some(link);
                        changes.push(Change::Messages);
                    }
                }
                Event::MessageBox { id, box_id } => {
                    if let Some(i) = st.index(id) {
                        st.messages[i].box_id = Some(box_id);
                        changes.push(Change::Messages);
                    }
                }
                Event::MessageUsage {
                    id,
                    tokens,
                    cost_usd,
                } => {
                    if let Some(r) = st.live(id) {
                        r.usage = Some(ReplyUsage { tokens, cost_usd });
                        changes.push(Change::Reply(id));
                    }
                }
                Event::MessageAttachment { id, attachment } => {
                    if let Some(i) = st.index(id)
                        && !st.messages[i]
                            .attachments
                            .iter()
                            .any(|a| a.id == attachment.id)
                    {
                        st.messages[i].attachments.push(attachment);
                        changes.push(Change::Messages);
                    }
                }
                Event::SpendUpdated {
                    today_usd,
                    month_usd,
                } => {
                    st.today_usd = Some(today_usd);
                    st.month_usd = Some(month_usd);
                    changes.push(Change::Spend);
                }
                Event::MemoryCommitted {
                    message, author, ..
                } => {
                    let by_bot = author == "Hatbot"
                        || st.bot_ids.iter().any(|b| st.bot_name(Some(b)) == author);
                    if by_bot {
                        changes.push(Change::Toast(format!("Memory: {message}")));
                    }
                    changes.push(Change::Memory);
                }
                Event::Paused { paused } => {
                    st.paused = paused;
                    changes.push(Change::Paused);
                }
                Event::TaskUpdated { task } => {
                    let id = task.id;
                    if task.status != TaskStatus::Running {
                        st.task_progress.remove(&id);
                    }
                    st.tasks.insert(id, task);
                    changes.extend([Change::Task(id), Change::NeedsYou]);
                }
                Event::TaskStepAdded { step } => {
                    let id = step.task_id;
                    if let Some(list) = st.steps.get_mut(&id) {
                        match list.iter().position(|s| s.id == step.id) {
                            Some(i) => list[i] = step,
                            None => list.push(step),
                        }
                        changes.push(Change::Task(id));
                    }
                }
                Event::TaskProgress { task_id, text } => {
                    let now = st.task_progress.get(&task_id).cloned().unwrap_or_default() + &text;
                    st.task_progress.insert(task_id, last_chars(&now, 400));
                    changes.push(Change::Task(task_id));
                }
                Event::ApprovalChanged { approval } => {
                    st.approvals.insert(approval.id, approval);
                    changes.push(Change::NeedsYou);
                }
                Event::QuestionChanged { question } => {
                    st.questions.insert(question.id, question);
                    changes.push(Change::NeedsYou);
                }
                Event::Desktop { state } => {
                    st.desktop = Some(state);
                    changes.extend([Change::Desktop, Change::NeedsYou]);
                }
                Event::ScheduleUpdated { schedule } => {
                    let id = schedule.id;
                    st.deleted_schedules.remove(&id);
                    st.schedules.insert(id, schedule);
                    changes.push(Change::Schedule(id));
                }
                Event::ScheduleDeleted { id } => {
                    st.schedules.remove(&id);
                    st.deleted_schedules.insert(id);
                    changes.push(Change::Schedule(id));
                }
                Event::BoxUpdated { app } => {
                    let id = app.id;
                    st.deleted_boxes.remove(&id);
                    st.boxes.insert(id, app);
                    changes.push(Change::Box(id));
                }
                Event::BoxDeleted { id } => {
                    st.boxes.remove(&id);
                    st.deleted_boxes.insert(id);
                    changes.push(Change::Box(id));
                }
                Event::EpisodeUpdated { episode } => {
                    st.episodes.insert(episode.id, episode);
                    changes.push(Change::Messages);
                }
                Event::BotUpdated { bot } => {
                    if !st.bot_ids.contains(&bot.id) {
                        st.bot_ids.push(bot.id.clone());
                    }
                    st.bots.insert(bot.id.clone(), bot);
                    changes.extend([Change::Chats, Change::Messages]);
                }
                Event::BotDeleted { id } => {
                    st.bot_ids.retain(|b| *b != id);
                    let gone: Vec<i64> = st
                        .conversations
                        .iter()
                        .filter(|c| {
                            c.kind == ConversationKind::Direct && c.bot_ids.first() == Some(&id)
                        })
                        .map(|c| c.id)
                        .collect();
                    drop(st);
                    for c in gone {
                        self.chat_gone(c);
                    }
                    self.refresh_conversations();
                    self.emit(Change::Chats);
                    return;
                }
                Event::ConversationUpdated { conversation } => {
                    match st
                        .conversations
                        .iter()
                        .position(|c| c.id == conversation.id)
                    {
                        Some(i) => st.conversations[i] = conversation,
                        None => st.conversations.push(conversation),
                    }
                    changes.push(Change::Chats);
                }
                Event::ConversationDeleted { id } => {
                    drop(st);
                    self.chat_gone(id);
                    return;
                }
                Event::SettingsUpdated => changes.push(Change::Settings),
                Event::Unknown => {}
            }
        }
        if refresh {
            self.refresh_conversations();
        }
        for c in changes {
            self.emit(c);
        }
    }

    // Chats

    /// A chat deleted, here or elsewhere. If it's the one you're in, back to Hatbot's own chat.
    fn chat_gone(&self, id: i64) {
        let open = {
            let mut st = self.state_mut();
            st.conversations.retain(|c| c.id != id);
            st.conversation_id == id
        };
        self.emit(Change::Chats);
        if open {
            let first = self.hatbot_chat();
            self.spawn(move |s| async move { s.open_conversation(first).await });
        }
    }

    /// Hatbot's own chat: the direct one with Hatbot.
    pub fn hatbot_chat(&self) -> i64 {
        let st = self.state();
        st.conversations
            .iter()
            .find(|c| {
                c.kind == ConversationKind::Direct
                    && c.bot_ids.first().map(String::as_str) == Some(HATBOT_ID)
            })
            .map_or(1, |c| c.id)
    }

    /// Bots and chats. A brain from before bots answers 404, and the app keeps to /thread.
    pub async fn load_bots(&self) {
        let (bots, chats) = futures_util::join!(
            self.0.api.get::<Vec<Bot>>("/bots"),
            self.0.api.get::<Vec<Conversation>>("/conversations")
        );
        let (Ok(bots), Ok(chats)) = (bots, chats) else {
            return;
        };
        {
            let mut st = self.state_mut();
            st.bot_ids = bots.iter().map(|b| b.id.clone()).collect();
            for b in bots {
                st.bots.insert(b.id.clone(), b);
            }
            st.conversations = chats;
        }
        self.emit(Change::Chats);
    }

    /// The chats' unread counts, soon: news comes in bursts. One load at a time, so an older answer
    /// can't land after a newer one; news meanwhile loads them once more.
    fn refresh_conversations(&self) {
        {
            let mut st = self.state_mut();
            if st.conversations.is_empty() {
                return;
            }
            if st.refreshing {
                st.refresh_again = true;
                return;
            }
            st.refreshing = true;
        }
        self.spawn(|s| async move {
            loop {
                s.state_mut().refresh_again = false;
                glib::timeout_future(s.0.refresh_delay.get()).await;
                if let Ok(chats) = s.0.api.get::<Vec<Conversation>>("/conversations").await {
                    s.state_mut().conversations = chats;
                    s.emit(Change::Chats);
                }
                if !s.state().refresh_again {
                    break;
                }
            }
            s.state_mut().refreshing = false;
        });
    }

    /// Shows another chat. Leaving one in incognito deletes its conversation.
    pub async fn open_conversation(&self, id: i64) {
        let (left, was_incognito) = {
            let mut st = self.state_mut();
            if st.conversation_id == id && !st.messages.is_empty() {
                return;
            }
            let left = st.chat_path();
            let was = st.incognito;
            st.conversation_id = id;
            st.incognito = false;
            st.messages.clear();
            st.replies.clear();
            st.has_earlier = false;
            st.loaded = false;
            (left, was)
        };
        self.emit(Change::Messages);
        if was_incognito {
            let _ = self.0.api.delete(&format!("{left}/incognito")).await;
        }
        let _ = self.load_thread().await;
    }

    /// Into incognito, or out of it, which deletes its conversation.
    pub async fn set_incognito(&self, on: bool) {
        let path = {
            let mut st = self.state_mut();
            if st.incognito == on {
                return;
            }
            st.incognito = on;
            st.messages.clear();
            st.replies.clear();
            st.has_earlier = false;
            st.loaded = false;
            st.chat_path()
        };
        self.emit(Change::Messages);
        if !on {
            let _ = self.0.api.delete(&format!("{path}/incognito")).await;
        }
        let _ = self.load_thread().await;
    }

    // Thread

    pub async fn load_thread(&self) -> Result<()> {
        let load = self.0.next_id.get() + 1;
        self.0.next_id.set(load);
        let (path, shown, incognito) = {
            let mut st = self.state_mut();
            st.missed.insert(load, vec![]);
            (st.page(None), st.conversation_id, st.incognito)
        };
        let result = self.0.api.get::<Vec<ThreadMessage>>(&path).await;
        let list = match result {
            Ok(list) => list,
            Err(e) => {
                self.state_mut().missed.remove(&load);
                return Err(e);
            }
        };
        let _ = self.load_episodes(&list).await;
        let missed = self.state_mut().missed.remove(&load).unwrap_or_default();
        {
            let mut st = self.state_mut();
            // Switched while it loaded: the other chat's load wins.
            if st.conversation_id != shown || st.incognito != incognito {
                return Ok(());
            }
            for m in list.iter().filter(|m| m.incognito) {
                st.incognito_ids.insert(m.id);
            }
            let loaded = std::mem::take(&mut st.messages);
            let (messages, has_earlier) = thread::merge(loaded, st.has_earlier, list.clone(), PAGE);
            st.messages = messages;
            st.has_earlier = has_earlier;
            st.loaded = true;
            st.sync_replies(&list);
            for e in &missed {
                st.follow(e);
            }
        }
        self.emit(Change::Messages);
        Ok(())
    }

    pub async fn load_earlier(&self) -> Result<()> {
        let (path, first, shown, incognito) = {
            let mut st = self.state_mut();
            let Some(first) = st.messages.first().map(|m| m.id) else {
                return Ok(());
            };
            if st.loading_earlier || !st.has_earlier {
                return Ok(());
            }
            st.loading_earlier = true;
            (
                st.page(Some(first)),
                first,
                st.conversation_id,
                st.incognito,
            )
        };
        let result = self.0.api.get::<Vec<ThreadMessage>>(&path).await;
        self.state_mut().loading_earlier = false;
        let older = result?;
        let _ = self.load_episodes(&older).await;
        {
            let mut st = self.state_mut();
            // Another chat, or in or out of incognito, while it loaded: the page belongs to the one you left.
            if st.conversation_id != shown
                || st.incognito != incognito
                || st.messages.first().map(|m| m.id) != Some(first)
            {
                return Ok(());
            }
            st.has_earlier = older.len() == PAGE;
            let mut all = older;
            all.append(&mut st.messages);
            st.messages = all;
        }
        self.emit(Change::Messages);
        Ok(())
    }

    /// Loads earlier pages until message `id` is in the chat, for a link to it; whether it is.
    pub async fn reveal(&self, id: i64) -> bool {
        if self.state().messages.is_empty() {
            let _ = self.load_thread().await;
        }
        for _ in 0..40 {
            let more = {
                let st = self.state();
                if st.index(id).is_some() {
                    return true;
                }
                st.has_earlier && st.messages.first().is_some_and(|m| id < m.id)
            };
            if !more {
                return false;
            }
            while self.state().loading_earlier {
                glib::timeout_future(Duration::from_millis(100)).await;
            }
            if self.load_earlier().await.is_err() {
                return false;
            }
        }
        self.state().index(id).is_some()
    }

    /// Deletes a conversation from the chat for good; message.deleted takes it off the screen.
    pub async fn delete_episode(&self, id: i64) -> Result<()> {
        let path = format!("{}/episodes/{id}", self.state().chat_path());
        self.0.api.delete(&path).await
    }

    /// Fetches the conversations of `list` we don't have yet. A brain from before folds answers 404.
    async fn load_episodes(&self, list: &[ThreadMessage]) -> Result<()> {
        let (ids, path) = {
            let st = self.state();
            let ids: BTreeSet<i64> = list
                .iter()
                .filter_map(|m| m.episode_id)
                .filter(|id| !st.episodes.contains_key(id))
                .collect();
            (ids, st.chat_path())
        };
        if ids.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = ids.iter().map(i64::to_string).collect();
        let found: Vec<Episode> = self
            .0
            .api
            .get(&format!("{path}/episodes?ids={}", ids.join(",")))
            .await?;
        let mut st = self.state_mut();
        for e in found {
            st.episodes.insert(e.id, e);
        }
        Ok(())
    }

    /// Posts your message. `client_id` is the same for every try of one message, so a lost answer
    /// sent again posts it once.
    pub async fn send(&self, text: &str, attachment_ids: &[i64], client_id: &str) -> Result<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            text: &'a str,
            attachment_ids: &'a [i64],
            incognito: bool,
            client_id: &'a str,
        }
        let (path, incognito) = {
            let st = self.state();
            (format!("{}/messages", st.chat_path()), st.incognito)
        };
        let body = Body {
            text,
            attachment_ids,
            incognito,
            client_id,
        };
        let m: ThreadMessage = self.0.api.post(&path, &body).await?;
        let shows = {
            let mut st = self.state_mut();
            let shows = st.shows(&m);
            if shows {
                st.upsert(m);
            }
            shows
        };
        if shows {
            self.emit(Change::Messages);
        }
        Ok(())
    }

    /// Uploads a file for your next message.
    pub async fn upload(&self, name: &str, media_type: &str, data: &[u8]) -> Result<Attachment> {
        self.0
            .api
            .upload("/attachments", name, media_type, data)
            .await
    }

    /// Writes an errored reply again: message.rewrite, then its deltas, follow.
    pub async fn retry(&self, message_id: i64) -> Result<()> {
        let path = format!("{}/messages/{message_id}/retry", self.state().chat_path());
        let _: serde_json::Value = self.0.api.post(&path, &Empty {}).await?;
        Ok(())
    }

    /// You've seen these messages: they stop counting as unread here and on your other devices.
    /// Rows that come into view together are told in one request.
    pub fn mark_seen(&self, ids: &[i64]) {
        {
            let mut st = self.state_mut();
            let seen: Vec<i64> = ids
                .iter()
                .copied()
                .filter(|id| st.unread.contains(id))
                .collect();
            if seen.is_empty() {
                return;
            }
            st.unread.retain(|id| !seen.contains(id));
            st.seen_queue.extend(seen);
        }
        self.emit(Change::Unread);
        if self.0.seen_flush.replace(true) {
            return;
        }
        self.spawn(|s| async move {
            glib::timeout_future(Duration::from_millis(200)).await;
            s.0.seen_flush.set(false);
            let ids = std::mem::take(&mut s.state_mut().seen_queue);
            #[derive(Serialize)]
            struct Body<'a> {
                ids: &'a [i64],
            }
            // The brain takes up to 200 at a time.
            for chunk in ids.chunks(200) {
                let _: Result<serde_json::Value> =
                    s.0.api.post("/thread/seen", &Body { ids: chunk }).await;
            }
        });
    }

    // Tasks, approvals and questions

    pub async fn load_task(&self, id: i64) -> Result<()> {
        let res: TaskWithSteps = self.0.api.get(&format!("/tasks/{id}")).await?;
        {
            let mut st = self.state_mut();
            st.tasks.insert(id, res.task);
            st.steps.insert(id, res.steps);
            st.task_files.insert(id, res.attachments);
        }
        self.emit(Change::Task(id));
        Ok(())
    }

    /// Loads a task the first time something shows it. The ones asked for together come in one request.
    pub fn ensure_task(&self, id: i64) {
        {
            let mut st = self.state_mut();
            if st.tasks.contains_key(&id) || !st.requested.insert(format!("t{id}")) {
                return;
            }
            st.wanted_tasks.push(id);
            if st.wanted_tasks.len() > 1 {
                return;
            }
        }
        self.spawn(|s| async move {
            let ids = std::mem::take(&mut s.state_mut().wanted_tasks);
            for some in ids.chunks(200) {
                let list = some
                    .iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                match s
                    .0
                    .api
                    .get::<Vec<Task>>(&format!("/tasks?ids={list}"))
                    .await
                {
                    Ok(tasks) => {
                        let mut got = vec![];
                        {
                            let mut st = s.state_mut();
                            for t in tasks {
                                got.push(t.id);
                                st.tasks.insert(t.id, t);
                            }
                            for id in some.iter().filter(|id| !got.contains(id)) {
                                st.requested.remove(&format!("t{id}"));
                            }
                        }
                        for id in got {
                            s.emit(Change::Task(id));
                        }
                    }
                    Err(_) => {
                        let mut st = s.state_mut();
                        for id in some {
                            st.requested.remove(&format!("t{id}"));
                        }
                    }
                }
            }
        });
    }

    pub fn ensure_schedule(&self, id: i64) {
        {
            let mut st = self.state_mut();
            if st.schedules.contains_key(&id)
                || st.deleted_schedules.contains(&id)
                || !st.requested.insert(format!("s{id}"))
            {
                return;
            }
        }
        self.spawn(move |s| async move {
            match s.0.api.get::<Schedule>(&format!("/schedules/{id}")).await {
                Ok(sc) => {
                    s.state_mut().schedules.insert(id, sc);
                }
                Err(ApiError { status: 404, .. }) => {
                    s.state_mut().deleted_schedules.insert(id);
                }
                Err(_) => {
                    s.state_mut().requested.remove(&format!("s{id}"));
                    return;
                }
            }
            s.emit(Change::Schedule(id));
        });
    }

    pub fn ensure_box(&self, id: i64) {
        {
            let mut st = self.state_mut();
            if st.boxes.contains_key(&id)
                || st.deleted_boxes.contains(&id)
                || !st.requested.insert(format!("x{id}"))
            {
                return;
            }
        }
        self.spawn(move |s| async move {
            // The box's fields, with its versions and secrets beside them.
            match s.0.api.get::<AppBox>(&format!("/boxes/{id}")).await {
                Ok(b) => {
                    s.state_mut().boxes.insert(id, b);
                }
                Err(ApiError { status: 404, .. }) => {
                    s.state_mut().deleted_boxes.insert(id);
                }
                Err(_) => {
                    s.state_mut().requested.remove(&format!("x{id}"));
                    return;
                }
            }
            s.emit(Change::Box(id));
        });
    }

    /// Pending approvals, questions, the desktop and unread messages; anything we thought pending
    /// that the brain doesn't list was decided meanwhile. All at once: none waits on another.
    pub async fn load_live(&self) -> Result<()> {
        let api = &self.0.api;
        let active: Vec<i64> = {
            let st = self.state();
            st.tasks
                .values()
                .filter(|t| st.steps.contains_key(&t.id) && t.status.is_active())
                .map(|t| t.id)
                .collect()
        };
        let ((), approvals, questions, desktop, unread, spend) = futures_util::join!(
            self.load_bots(),
            api.get::<Vec<Approval>>("/approvals?pending=1"),
            api.get::<Vec<Question>>("/questions"),
            api.get::<DesktopState>("/desktop/status"),
            api.get::<Vec<i64>>("/thread/unread"),
            api.get::<serde_json::Value>("/spend/summary"),
        );
        let pending = approvals?;
        {
            let mut st = self.state_mut();
            st.approvals
                .retain(|_, a| a.status != ApprovalStatus::Pending);
            for a in pending {
                st.approvals.insert(a.id, a);
            }
            // Those answered or dropped meanwhile aren't listed.
            if let Ok(list) = questions {
                st.questions = list.into_iter().map(|q| (q.id, q)).collect();
            }
            st.desktop = desktop.ok();
            if let Ok(list) = unread {
                st.unread = list.into_iter().collect();
            }
            if let Ok(s) = spend {
                st.today_usd = s.get("todayUsd").and_then(|v| v.as_f64());
                st.month_usd = s.get("monthUsd").and_then(|v| v.as_f64());
            }
        }
        for c in [
            Change::NeedsYou,
            Change::Desktop,
            Change::Unread,
            Change::Spend,
        ] {
            self.emit(c);
        }
        futures_util::future::join_all(active.into_iter().map(|id| self.load_task(id))).await;
        Ok(())
    }

    /// Approves or denies, with what to do instead or how to go ahead.
    pub async fn decide(&self, id: i64, approve: bool, note: &str) -> Result<()> {
        #[derive(Serialize)]
        struct Body<'a> {
            decision: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            note: Option<&'a str>,
        }
        let note = note.trim();
        let body = Body {
            decision: if approve { "approve" } else { "deny" },
            note: (!note.is_empty()).then_some(note),
        };
        let a: Approval = self.0.api.post(&format!("/approvals/{id}"), &body).await?;
        self.state_mut().approvals.insert(a.id, a);
        self.emit(Change::NeedsYou);
        Ok(())
    }

    pub async fn answer(&self, id: i64, answer: &str) -> Result<()> {
        #[derive(Serialize)]
        struct Body<'a> {
            answer: &'a str,
        }
        let q: Question = self
            .0
            .api
            .post(&format!("/questions/{id}"), &Body { answer })
            .await?;
        self.state_mut().questions.insert(q.id, q);
        self.emit(Change::NeedsYou);
        Ok(())
    }

    /// A page of active or finished tasks, newest first: their ids.
    pub async fn load_tasks(&self, done: bool, before: Option<i64>) -> Result<Vec<i64>> {
        let mut path = format!("/tasks?status={}", if done { "done" } else { "active" });
        if let Some(b) = before {
            path += &format!("&before={b}");
        }
        let list: Vec<Task> = self.0.api.get(&path).await?;
        let ids = list.iter().map(|t| t.id).collect();
        {
            let mut st = self.state_mut();
            for t in list {
                st.tasks.insert(t.id, t);
            }
        }
        self.emit(Change::Tasks);
        Ok(ids)
    }

    /// Runs an ended task again, with a new goal if you changed it: the new task.
    pub async fn rerun_task(&self, id: i64, goal: Option<&str>) -> Result<Task> {
        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            goal: Option<&'a str>,
        }
        let t: Task = self
            .0
            .api
            .post(&format!("/tasks/{id}/rerun"), &Body { goal })
            .await?;
        self.state_mut().tasks.insert(t.id, t.clone());
        self.emit(Change::Task(t.id));
        Ok(t)
    }

    /// An approval a link points to, which may have come while the stream was down.
    pub async fn load_approval(&self, id: i64) -> Result<Approval> {
        let a: Approval = self.0.api.get(&format!("/approvals/{id}")).await?;
        self.state_mut().approvals.insert(a.id, a.clone());
        self.emit(Change::NeedsYou);
        Ok(a)
    }

    pub async fn cancel_task(&self, id: i64) -> Result<()> {
        self.0.api.post_empty(&format!("/tasks/{id}/cancel")).await
    }

    // Admin

    pub async fn set_paused(&self, value: bool) -> Result<()> {
        self.0
            .api
            .post_empty(if value { "/pause-all" } else { "/resume" })
            .await?;
        self.state_mut().paused = value;
        self.emit(Change::Paused);
        Ok(())
    }
}

/// The last `n` characters of `s`.
fn last_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}
