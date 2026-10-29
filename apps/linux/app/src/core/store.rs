// What's live, as the stream tells it: the same shape as apps/web/src/store.ts and iOS's AppStore.
// Pure state: loads happen in the UI layer, which asks for them through `Effect`s.
use std::collections::{BTreeMap, HashMap, HashSet};

use super::delta;
use super::models::*;

pub const PAGE: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// The chats' unread counts and latest messages changed.
    RefreshConversations,
    /// The stream opened: the open chat's latest page, and the tasks its cards show.
    LoadThread,
    RefreshTasks,
    Toast(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveReply {
    pub text: String,
    pub progress: String,
    pub usage: Option<(i64, f64)>,
}

#[derive(Debug, Default)]
pub struct Store {
    pub connected: bool,
    pub paused: bool,
    pub today_usd: Option<f64>,
    pub month_usd: Option<f64>,

    pub bots: HashMap<String, Bot>,
    pub bot_ids: Vec<String>,
    pub conversations: Vec<Conversation>,
    /// Threads of the chats you've opened; they stay out of the chat list.
    pub threads: HashMap<i64, Conversation>,

    /// The chat that's showing: a bot's own, a group or a thread.
    pub conversation_id: i64,
    pub incognito: bool,
    pub messages: Vec<ThreadMessage>,
    pub has_earlier: bool,
    /// The open chat's messages are known: until then, none isn't an empty chat.
    pub thread_known: bool,
    pub replies: HashMap<i64, LiveReply>,
    pub episodes: HashMap<i64, Episode>,
    pub unread: Vec<i64>,
    incognito_ids: HashSet<i64>,
    /// Message events that came while the latest page loaded: the page may have been read before them.
    missed: Option<Vec<Event>>,

    pub tasks: HashMap<i64, Task>,
    pub steps: HashMap<i64, Vec<TaskStep>>,
    pub task_progress: HashMap<i64, String>,
    pub approvals: BTreeMap<i64, Approval>,
    pub questions: BTreeMap<i64, Question>,
    pub desktop: Option<DesktopState>,
    pub schedules: BTreeMap<i64, Schedule>,
    pub triggers: BTreeMap<i64, Trigger>,
    pub watchers: BTreeMap<i64, Watcher>,
    pub boxes: BTreeMap<i64, AppBox>,
    pub deleted_boxes: HashSet<i64>,
    pub proposals: BTreeMap<i64, Proposal>,

    /// Bumped so open views refetch.
    pub memory_version: u64,
    pub settings_version: u64,
    pub heartbeat_version: u64,
}

impl Store {
    pub fn new() -> Self {
        Self { conversation_id: 1, ..Self::default() }
    }

    pub fn pending_approvals(&self) -> Vec<&Approval> {
        self.approvals.values().filter(|a| a.status == ApprovalStatus::Pending).collect()
    }

    pub fn pending_questions(&self) -> Vec<&Question> {
        self.questions.values().filter(|q| q.status == QuestionStatus::Pending).collect()
    }

    /// What waits on you: approvals, questions and a request to take over the desktop.
    pub fn needs_you(&self) -> usize {
        self.pending_approvals().len()
            + self.pending_questions().len()
            + usize::from(self.desktop.as_ref().is_some_and(|d| d.request.is_some()))
    }

    pub fn bot_name(&self, id: Option<&str>) -> String {
        match id {
            None => String::new(),
            Some(id) => self.bots.get(id).map(|b| b.name.clone()).unwrap_or_else(|| {
                if id == HATBOT_ID { "Hatbot".into() } else { id.into() }
            }),
        }
    }

    pub fn chat_name(&self, c: Option<&Conversation>) -> String {
        let Some(c) = c else { return "Hatbot".into() };
        match c.kind {
            ConversationKind::Group => c.title.clone().unwrap_or_else(|| {
                c.bot_ids.iter().map(|b| self.bot_name(Some(b))).collect::<Vec<_>>().join(", ")
            }),
            ConversationKind::Thread => c.title.clone().unwrap_or_else(|| "Thread".into()),
            ConversationKind::Direct => self.bot_name(c.bot_ids.first().map(String::as_str)),
        }
    }

    pub fn current_chat(&self) -> Option<&Conversation> {
        self.conversations
            .iter()
            .find(|c| c.id == self.conversation_id)
            .or_else(|| self.threads.get(&self.conversation_id))
    }

    /// The chat the list shows as open: a thread's own chat while you're in the thread.
    pub fn listed_chat_id(&self) -> i64 {
        self.current_chat().and_then(|c| c.parent_id).unwrap_or(self.conversation_id)
    }

    /// The chat's API path; a brain from before bots has only /thread.
    pub fn chat_path(&self) -> String {
        if self.conversations.is_empty() {
            "/thread".into()
        } else {
            format!("/conversations/{}", self.conversation_id)
        }
    }

    pub fn page_path(&self, before: Option<i64>) -> String {
        let mut p = format!("{}/messages?limit={PAGE}", self.chat_path());
        if let Some(b) = before {
            p += &format!("&before={b}");
        }
        if self.incognito {
            p += "&incognito=1";
        }
        p
    }

    /// Its bot marked it, or an approval or a question waits in it.
    pub fn thread_needs_you(&self, t: &Conversation) -> bool {
        t.needs_you
            || self.pending_approvals().iter().any(|a| a.conversation_id == Some(t.id))
            || self.pending_questions().iter().any(|q| q.conversation_id == Some(t.id))
    }

    pub fn text<'a>(&'a self, m: &'a ThreadMessage) -> &'a str {
        if m.status == MessageStatus::Streaming
            && let Some(r) = self.replies.get(&m.id)
        {
            return &r.text;
        }
        &m.text
    }

    /// Opens another chat: what's shown goes until its page loads.
    pub fn open(&mut self, id: i64) {
        self.conversation_id = id;
        self.incognito = false;
        self.messages.clear();
        self.replies.clear();
        self.has_earlier = false;
        self.thread_known = false;
    }

    pub fn put_conversation(&mut self, c: Conversation) {
        if c.kind == ConversationKind::Thread {
            self.threads.insert(c.id, c);
            return;
        }
        match self.conversations.iter_mut().find(|x| x.id == c.id) {
            Some(x) => *x = c,
            None => self.conversations.push(c),
        }
    }

    pub fn take_bots(&mut self, bots: Vec<Bot>) {
        self.bot_ids = bots.iter().map(|b| b.id.clone()).collect();
        for b in bots {
            self.bots.insert(b.id.clone(), b);
        }
    }

    /// Starts a load of the latest page: message events from now on are kept to replay over it.
    pub fn loading_page(&mut self) {
        self.missed = Some(Vec::new());
    }

    /// The latest page, merged into what's loaded. The page is the truth from its first message on;
    /// earlier pages you'd loaded stay, unless more than a page came while away.
    pub fn take_page(&mut self, conversation: i64, incognito: bool, latest: Vec<ThreadMessage>) {
        let missed = self.missed.take().unwrap_or_default();
        if conversation != self.conversation_id || incognito != self.incognito {
            return;
        }
        let full = latest.len() == PAGE;
        match (latest.first().map(|m| m.id), self.messages.last().map(|m| m.id)) {
            (Some(floor), Some(last)) => {
                if full && last < floor {
                    self.has_earlier = true;
                    self.messages = latest;
                } else {
                    let before: Vec<_> = if full {
                        self.messages.iter().filter(|m| m.id < floor).cloned().collect()
                    } else {
                        Vec::new()
                    };
                    if before.is_empty() {
                        self.has_earlier = full;
                    }
                    self.messages = before.into_iter().chain(latest).collect();
                }
            }
            _ => {
                self.has_earlier = full;
                self.messages = latest;
            }
        }
        self.thread_known = true;
        let streaming: HashMap<i64, String> = self
            .messages
            .iter()
            .filter(|m| m.status == MessageStatus::Streaming)
            .map(|m| (m.id, m.text.clone()))
            .collect();
        self.replies.retain(|id, _| streaming.contains_key(id));
        for (id, text) in streaming {
            self.replies.entry(id).or_default().text = text;
        }
        for e in missed {
            self.follow(&e);
        }
    }

    /// An earlier page, put before what's shown.
    pub fn take_earlier(&mut self, conversation: i64, first: i64, older: Vec<ThreadMessage>) {
        if conversation != self.conversation_id || self.messages.first().map(|m| m.id) != Some(first) {
            return;
        }
        self.has_earlier = older.len() == PAGE;
        let mut all = older;
        all.append(&mut self.messages);
        self.messages = all;
    }

    pub fn take_task(&mut self, t: Task) {
        let held = self.tasks.get(&t.id);
        let t = t.keeping(held);
        if t.status != TaskStatus::Running {
            self.task_progress.remove(&t.id);
        }
        self.tasks.insert(t.id, t);
    }

    pub fn take_live(&mut self, approvals: Vec<Approval>, questions: Vec<Question>, desktop: Option<DesktopState>, unread: Vec<i64>) {
        self.approvals.retain(|_, a| a.status != ApprovalStatus::Pending);
        for a in approvals {
            self.approvals.insert(a.id, a);
        }
        self.questions.retain(|_, q| q.status != QuestionStatus::Pending);
        for q in questions {
            self.questions.insert(q.id, q);
        }
        if desktop.is_some() {
            self.desktop = desktop;
        }
        self.unread = unread;
        self.unread.sort_unstable();
    }

    fn add_unread(&mut self, id: i64) {
        if self.incognito_ids.contains(&id) || self.unread.contains(&id) {
            return;
        }
        self.unread.push(id);
        self.unread.sort_unstable();
    }

    /// You've seen these: they stop counting as unread here; the caller tells the brain.
    pub fn mark_seen(&mut self, ids: &[i64]) -> Vec<i64> {
        let seen: Vec<i64> = ids.iter().copied().filter(|id| self.unread.contains(id)).collect();
        self.unread.retain(|id| !seen.contains(id));
        seen
    }

    pub fn apply(&mut self, event: Event) -> Vec<Effect> {
        let mut fx = Vec::new();
        if let Some(missed) = &mut self.missed
            && matches!(
                event,
                Event::MessageCreated { .. }
                    | Event::MessageDelta { at: Some(_), .. }
                    | Event::MessageDone { .. }
                    | Event::MessageRewrite { .. }
                    | Event::MessageEdited { .. }
                    | Event::MessageSeen { .. }
                    | Event::MessageDeleted { .. }
                    | Event::MessageTask { .. }
                    | Event::MessageLinked { .. }
                    | Event::MessageBox { .. }
                    | Event::MessageAttachment { .. }
            )
        {
            missed.push(event.clone());
        }
        match event {
            Event::Snapshot(s) => {
                self.take_bots(s.bots);
                self.conversations = s.conversations;
                self.paused = s.paused;
                self.take_live(s.approvals, s.questions, s.desktop, s.unread);
                fx.push(Effect::RefreshTasks);
            }
            Event::MessageCreated { ref message } => {
                let m = message.clone();
                if m.incognito {
                    self.incognito_ids.insert(m.id);
                }
                if m.role == Role::Assistant {
                    fx.push(Effect::RefreshConversations);
                }
                self.follow(&event);
                if m.role == Role::Assistant && m.status != MessageStatus::Streaming && m.seen_at.is_none() {
                    self.add_unread(m.id);
                }
            }
            Event::MessageEdited { id, .. } => {
                self.follow(&event);
                self.add_unread(id);
                fx.push(Effect::RefreshConversations);
            }
            Event::MessageSeen { ref ids, .. } => {
                let ids = ids.clone();
                self.follow(&event);
                self.unread.retain(|id| !ids.contains(id));
                fx.push(Effect::RefreshConversations);
            }
            Event::MessageDeleted { ref ids } => {
                let ids = ids.clone();
                self.follow(&event);
                self.unread.retain(|id| !ids.contains(id));
            }
            Event::MessageDone { id, .. } => {
                self.follow(&event);
                self.add_unread(id);
                fx.push(Effect::RefreshConversations);
            }
            Event::MessageDelta { at: None, .. } => {}
            Event::MessageRewrite { .. }
            | Event::MessageDelta { .. }
            | Event::MessageTask { .. }
            | Event::MessageLinked { .. }
            | Event::MessageBox { .. }
            | Event::MessageAttachment { .. } => self.follow(&event),
            Event::MessageProgress { id, text } => {
                if let Some(r) = self.live(id) {
                    r.progress = tail(&(r.progress.clone() + &text), 400);
                }
            }
            Event::MessageUsage { id, tokens, cost_usd } => {
                if let Some(r) = self.live(id) {
                    r.usage = Some((tokens, cost_usd));
                }
            }
            Event::SpendUpdated { today_usd, month_usd } => {
                self.today_usd = Some(today_usd);
                self.month_usd = Some(month_usd);
            }
            Event::MemoryCommitted { message, author, .. } => {
                let by_bot = author == "Hatbot" || self.bot_ids.iter().any(|b| self.bot_name(Some(b)) == author);
                if by_bot {
                    fx.push(Effect::Toast(format!("Memory: {message}")));
                }
                self.memory_version += 1;
            }
            Event::Paused { paused } => self.paused = paused,
            Event::TaskUpdated { task } => self.take_task(task),
            Event::TaskStepAdded { step } => {
                if let Some(list) = self.steps.get_mut(&step.task_id) {
                    match list.iter_mut().find(|s| s.id == step.id) {
                        Some(s) => *s = step,
                        None => list.push(step),
                    }
                }
            }
            Event::TaskProgress { task_id, text } => {
                let p = self.task_progress.entry(task_id).or_default();
                *p = tail(&(p.clone() + &text), 400);
            }
            Event::ApprovalCreated { approval } | Event::ApprovalResolved { approval } => {
                self.approvals.insert(approval.id, approval);
            }
            Event::QuestionCreated { question } | Event::QuestionResolved { question } => {
                self.questions.insert(question.id, question);
            }
            Event::Desktop { state } => self.desktop = Some(state),
            Event::ScheduleUpdated { schedule } => {
                self.schedules.insert(schedule.id, schedule);
            }
            Event::ScheduleDeleted { id } => {
                self.schedules.remove(&id);
            }
            Event::TriggerUpdated { trigger } => {
                self.triggers.insert(trigger.id, trigger);
            }
            Event::TriggerDeleted { id } => {
                self.triggers.remove(&id);
            }
            Event::WatcherUpdated { watcher } => {
                self.watchers.insert(watcher.id, watcher);
            }
            Event::WatcherDeleted { id } => {
                self.watchers.remove(&id);
            }
            Event::EpisodeUpdated { episode } => {
                self.episodes.insert(episode.id, episode);
            }
            Event::BotUpdated { bot } => {
                if !self.bot_ids.contains(&bot.id) {
                    self.bot_ids.push(bot.id.clone());
                }
                self.bots.insert(bot.id.clone(), bot);
            }
            Event::BotDeleted { id } => {
                self.bot_ids.retain(|b| *b != id);
                let gone: Vec<i64> = self
                    .conversations
                    .iter()
                    .filter(|c| c.kind == ConversationKind::Direct && c.bot_ids.first() == Some(&id))
                    .map(|c| c.id)
                    .collect();
                for c in gone {
                    self.chat_gone(c);
                }
                fx.push(Effect::RefreshConversations);
            }
            Event::ConversationUpdated { conversation } => self.put_conversation(conversation),
            Event::ConversationDeleted { id } => {
                if self.chat_gone(id) {
                    fx.push(Effect::LoadThread);
                }
            }
            Event::ProposalUpdated { proposal } => {
                self.proposals.insert(proposal.id, proposal);
            }
            Event::BoxUpdated { app } => {
                self.deleted_boxes.remove(&app.id);
                self.boxes.insert(app.id, app);
            }
            Event::BoxDeleted { id } => {
                self.boxes.remove(&id);
                self.deleted_boxes.insert(id);
            }
            Event::SettingsUpdated => self.settings_version += 1,
            Event::HeartbeatUpdated => self.heartbeat_version += 1,
            Event::Unknown => {}
        }
        fx
    }

    /// A chat deleted, here or elsewhere. True when it was the one you're in: back to Hatbot's own.
    fn chat_gone(&mut self, id: i64) -> bool {
        self.conversations.retain(|c| c.id != id);
        let mut gone = vec![id];
        gone.extend(self.threads.values().filter(|t| t.parent_id == Some(id)).map(|t| t.id));
        for t in &gone {
            self.threads.remove(t);
        }
        if gone.contains(&self.conversation_id) {
            let first = self.conversations.first().map_or(1, |c| c.id);
            self.open(first);
            return true;
        }
        false
    }

    /// The live reply for a streaming message, made here for one loaded mid-reply.
    fn live(&mut self, id: i64) -> Option<&mut LiveReply> {
        if !self.replies.contains_key(&id) {
            let m = self.messages.iter().find(|m| m.id == id && m.status == MessageStatus::Streaming)?;
            let text = m.text.clone();
            self.replies.insert(id, LiveReply { text, ..LiveReply::default() });
        }
        self.replies.get_mut(&id)
    }

    fn change(&mut self, id: i64, f: impl FnOnce(&mut ThreadMessage)) {
        if let Some(m) = self.messages.iter_mut().find(|m| m.id == id) {
            f(m);
        }
    }

    /// What a message's own events do to it, also on a page read before they came.
    fn follow(&mut self, event: &Event) {
        match event {
            Event::MessageCreated { message: m } => {
                if m.incognito != self.incognito || m.conversation_id != self.conversation_id {
                    return;
                }
                if m.status == MessageStatus::Streaming && !self.replies.contains_key(&m.id) {
                    self.replies.insert(m.id, LiveReply { text: m.text.clone(), ..LiveReply::default() });
                }
                match self.messages.iter_mut().find(|x| x.id == m.id) {
                    Some(x) => {
                        let episode = x.episode_id;
                        *x = m.clone();
                        x.episode_id = x.episode_id.or(episode);
                    }
                    None => {
                        self.messages.push(m.clone());
                        self.messages.sort_by_key(|m| m.id);
                    }
                }
            }
            Event::MessageEdited { id, edited_at } => {
                let e = edited_at.clone();
                self.change(*id, |m| m.edited_at = Some(e));
            }
            Event::MessageSeen { ids, seen_at } => {
                for m in self.messages.iter_mut().filter(|m| ids.contains(&m.id)) {
                    m.seen_at = Some(seen_at.clone());
                }
            }
            Event::MessageDeleted { ids } => {
                for id in ids {
                    self.replies.remove(id);
                }
                self.messages.retain(|m| !ids.contains(&m.id));
            }
            Event::MessageTask { id, task_id } => {
                let t = *task_id;
                self.change(*id, |m| m.task_id = Some(t));
            }
            Event::MessageLinked { id, link } => {
                let l = *link;
                self.change(*id, |m| m.link = Some(l));
            }
            Event::MessageBox { id, box_id } => {
                let b = *box_id;
                self.change(*id, |m| m.box_id = Some(b));
            }
            Event::MessageAttachment { id, attachment } => {
                let a = attachment.clone();
                self.change(*id, |m| {
                    if !m.attachments.iter().any(|x| x.id == a.id) {
                        m.attachments.push(a);
                    }
                });
            }
            Event::MessageRewrite { id } => {
                if self.messages.iter().any(|m| m.id == *id) {
                    self.replies.insert(*id, LiveReply::default());
                    self.change(*id, |m| {
                        m.text.clear();
                        m.status = MessageStatus::Streaming;
                    });
                }
            }
            Event::MessageDelta { id, text, at } => {
                if let Some(r) = self.live(*id) {
                    r.text = delta::added(text, &r.text, *at);
                }
            }
            Event::MessageDone { id, text, status, sources, choices } => {
                self.replies.remove(id);
                let (text, status, sources, choices) = (text.clone(), *status, sources.clone(), choices.clone());
                self.change(*id, |m| {
                    m.text = text;
                    m.status = status;
                    if let Some(s) = sources {
                        m.sources = s;
                    }
                    if let Some(c) = choices {
                        m.choices = c;
                    }
                });
            }
            _ => {}
        }
    }
}

/// The last `max` characters, so progress text stays short.
fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max { s.to_string() } else { s.chars().skip(n - max).collect() }
}
