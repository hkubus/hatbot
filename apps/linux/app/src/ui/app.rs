// One process for everything: windowless at login, holding the stream, the tray and notifications;
// the window opens over it when asked.
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use iced::theme::Mode;
use iced::widget::{container, text};
use iced::{Element, Length, Size, Subscription, Task, Theme, window};

use super::chat::{self, Chat};
use super::pages::{self, Pages};
use super::{confirm, login, shell, theme};
use crate::core::api::{Api, ApiError};
use crate::core::models::Task as AgentTask;
use crate::core::models::*;
use crate::core::notify::{Notice, Reply, Target};
use crate::core::socket::{self, SocketEvent};
use crate::core::store::{Effect, Store};
use crate::core::{notify, vault};
use crate::desk::banner;
use crate::desk::inbox::{self, Outside};
use crate::desk::{notices, tray};

pub const APP_ID: &str = "ovh.gaycats.Hatbot";

#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    Chat,
    Threads,
    Bot(String),
    NewBot,
    Group(Option<i64>),
    Tasks,
    Task(i64),
    Live,
    Schedules,
    Memory,
    Todo,
    Boxes,
    Search,
    Settings,
    Spend,
    Computer,
}

#[derive(Debug, Clone)]
pub enum Streamed {
    Open { reconnected: bool },
    Event(Box<Event>),
    Closed,
    Unauthorized,
}

#[derive(Debug, Clone)]
pub enum Message {
    Mode(Mode),
    Outside(Outside),
    WindowOpened(window::Id),
    WindowClosed(window::Id),
    Focused(bool),
    Resized(f32),
    ChatMenu(bool),
    Restored(Option<(String, String)>),
    Login(login::Msg),
    SignedIn(Result<(String, String), String>),
    Kept(Result<(), String>),
    Stream(Streamed),
    Go(Route),
    Shortcut(String),
    Batch(Vec<Message>),
    Ask(Box<confirm::Dialog>),
    Answer(bool),
    Chat(chat::Msg),
    Page(pages::Msg),
    Loaded(Loaded),
    Toast(String),
    ToastGone(u64),
    Link(String),
    Copy(String),
    Retry,
    DownCheck(u64),
    SetPaused(bool),
    SignOut,
    Unauthorized,
    Nothing,
}

/// What the shell itself loads.
#[derive(Debug, Clone)]
pub enum Loaded {
    Chats(Vec<Bot>, Vec<Conversation>),
    Live {
        approvals: Vec<Approval>,
        questions: Option<Vec<Question>>,
        desktop: Option<DesktopState>,
        unread: Option<Vec<i64>>,
    },
    Plugins(Vec<PluginName>),
    Cards(Vec<AgentTask>),
    Settings(AppSettings),
}

pub enum Phase {
    Starting,
    Out(login::Login),
    In(Box<Session>),
}

pub struct App {
    pub dark: bool,
    pub window: Option<window::Id>,
    pub width: f32,
    pub phase: Phase,
    pub config: vault::Config,
    pub toast: Option<(u64, String)>,
    toasts: u64,
    banner: Option<banner::Shown>,
    agent: Option<hatbot_agent::AgentHandle>,
    pub agent_state: inbox::AgentState,
    /// A page asked for before signing in finished.
    start: Option<String>,
    dialog: Option<Box<confirm::Dialog>>,
}

pub struct Session {
    pub api: Api,
    pub store: Store,
    pub route: Route,
    /// Bumped to drop the stream and connect again at once.
    pub generation: u64,
    pub unreachable: bool,
    down: u64,
    awaiting_snapshot: bool,
    pub plugins: Option<Vec<PluginName>>,
    pub settings: Option<AppSettings>,
    pub chat: Chat,
    pub pages: Pages,
    /// The chats' menu under the chat's name, where there's no sidebar.
    pub chat_menu: bool,
    /// What's shown as notifications, by key.
    noticed: HashMap<String, Notice>,
    /// Approvals and questions already notified once: a snapshot after a reconnect doesn't show them again.
    seen: BTreeMap<String, ()>,
}

impl Session {
    fn new(server: &str, token: String) -> Self {
        Session {
            api: Api::new(server, Some(token)),
            store: Store::new(),
            route: Route::Chat,
            generation: 0,
            unreachable: false,
            down: 0,
            awaiting_snapshot: false,
            plugins: None,
            settings: None,
            chat: Chat::default(),
            pages: Pages::default(),
            chat_menu: false,
            noticed: HashMap::new(),
            seen: BTreeMap::new(),
        }
    }

    /// Runs a call against the brain and maps its result.
    pub fn call<T, F>(
        &self,
        f: impl FnOnce(Api) -> F,
        map: impl FnOnce(Result<T, ApiError>) -> Message + Send + 'static,
    ) -> Task<Message>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, ApiError>> + Send + 'static,
    {
        Task::perform(f(self.api.clone()), map)
    }

    /// A call whose only answer that matters is a failure.
    pub fn fire<F>(&self, f: impl FnOnce(Api) -> F) -> Task<Message>
    where
        F: Future<Output = Result<(), ApiError>> + Send + 'static,
    {
        self.call(f, |r| match r {
            Ok(()) => Message::Nothing,
            Err(e) => failed(e),
        })
    }

    pub fn plugin_on(&self, id: &str) -> bool {
        self.plugins.as_ref().is_none_or(|l| l.iter().any(|p| p.id == id && p.enabled))
    }
}

/// An error from the brain as a message: a turned-away token signs out, the rest show as a toast.
pub fn failed(e: ApiError) -> Message {
    if e.is_unauthorized() { Message::Unauthorized } else { Message::Toast(e.message) }
}

pub fn boot(open_window: bool, page: Option<String>) -> (App, Task<Message>) {
    let config = vault::load_config();
    let app = App {
        dark: true,
        window: None,
        width: 1280.0,
        phase: Phase::Starting,
        config: config.clone(),
        toast: None,
        toasts: 0,
        banner: None,
        agent: None,
        agent_state: Default::default(),
        start: page,
        dialog: None,
    };
    let restore = Task::perform(
        async move {
            let server = config.server?;
            let token = vault::load(&server).await?;
            Some((server, token))
        },
        Message::Restored,
    );
    let mut tasks = vec![
        iced::system::theme().map(Message::Mode),
        restore,
        Task::future(async {
            tray::start().await;
            Message::Nothing
        }),
    ];
    if let Ok(l) = crate::desk::instance::listen() {
        tasks.push(Task::future(async move {
            crate::desk::instance::serve(l).await;
            Message::Nothing
        }));
    }
    let (app, open) = if open_window {
        let mut app = app;
        let t = app.open_window();
        (app, t)
    } else {
        (app, Task::none())
    };
    tasks.push(open);
    (app, Task::batch(tasks))
}

impl App {
    fn open_window(&mut self) -> Task<Message> {
        if let Some(id) = self.window {
            return window::gain_focus(id);
        }
        let (id, open) = window::open(window::Settings {
            size: Size::new(1280.0, 820.0),
            min_size: Some(Size::new(720.0, 480.0)),
            platform_specific: window::settings::PlatformSpecific {
                application_id: APP_ID.into(),
                ..Default::default()
            },
            ..Default::default()
        });
        self.window = Some(id);
        open.map(Message::WindowOpened)
    }

    pub fn session(&self) -> Option<&Session> {
        match &self.phase {
            Phase::In(s) => Some(s),
            _ => None,
        }
    }

    pub fn session_mut(&mut self) -> Option<&mut Session> {
        match &mut self.phase {
            Phase::In(s) => Some(s),
            _ => None,
        }
    }

    fn sync_tray(&self) {
        let s = self.session();
        tray::set(tray::Tray {
            signed_in: s.is_some(),
            needs_you: s.map_or(0, |s| s.store.needs_you()),
            paused: s.is_some_and(|s| s.store.paused),
            using_computer: self.agent_state.using(),
        });
    }

    fn sync_banner(&mut self) {
        let using = self.agent_state.using();
        if using && self.banner.is_none() {
            let output = self.agent_state.status.screen.as_ref().map(|s| s.output.clone());
            self.banner = banner::Shown::start(output.as_deref());
        } else if !using && let Some(b) = self.banner.take() {
            b.stop();
        }
    }

    fn start_agent(&mut self) {
        let Some(s) = self.session() else { return };
        if self.agent.is_some() {
            return;
        }
        let handle = hatbot_agent::Agent::start(hatbot_agent::AgentConfig {
            brain_url: s.api.server.clone(),
            device_token: s.api.token.clone().unwrap_or_default(),
            enabled: self.config.computer_enabled,
        });
        let (mut status, mut connection) = (handle.status(), handle.connection());
        tokio::spawn(async move {
            loop {
                let state = inbox::AgentState {
                    online: *connection.borrow_and_update() == hatbot_agent::Connection::Connected,
                    status: status.borrow_and_update().clone(),
                };
                inbox::send(Outside::Agent(state));
                tokio::select! {
                    r = status.changed() => if r.is_err() { break },
                    r = connection.changed() => if r.is_err() { break },
                }
            }
        });
        self.agent = Some(handle);
    }

    pub fn agent(&self) -> Option<&hatbot_agent::AgentHandle> {
        self.agent.as_ref()
    }

    pub fn set_computer_enabled(&mut self, on: bool) {
        self.config.computer_enabled = on;
        vault::save_config(&self.config);
        if let Some(a) = &self.agent {
            a.set_enabled(on);
        }
    }

    fn signed_in(&mut self, server: String, token: String) -> Task<Message> {
        self.phase = Phase::In(Box::new(Session::new(&server, token)));
        self.config.server = Some(server);
        vault::save_config(&self.config);
        self.start_agent();
        self.sync_tray();
        let start = self.start.take();
        let s = self.session().unwrap();
        let mut t = vec![load_chats(s), load_plugins(s), load_settings(s), chat::load_page(s)];
        t.extend(start.iter().flat_map(|p| pages::link(p)).flatten().map(Task::done));
        Task::batch(t)
    }

    fn sign_out(&mut self) -> Task<Message> {
        let server = self.session().map(|s| s.api.server.clone());
        if let Some(a) = self.agent.take() {
            a.shutdown();
        }
        if let Phase::In(s) = &self.phase {
            for key in s.noticed.keys() {
                notices::close(key);
            }
        }
        self.phase = Phase::Out(login::Login::new(server.clone().unwrap_or_default()));
        self.agent_state = Default::default();
        self.sync_banner();
        self.sync_tray();
        match server {
            Some(server) => Task::future(async move {
                vault::clear(&server).await;
                Message::Nothing
            }),
            None => Task::none(),
        }
    }

    pub fn toast(&mut self, text: String) -> Task<Message> {
        self.toasts += 1;
        let id = self.toasts;
        self.toast = Some((id, text));
        Task::future(async move {
            tokio::time::sleep(Duration::from_secs(4)).await;
            Message::ToastGone(id)
        })
    }
}

pub fn update(app: &mut App, message: Message) -> Task<Message> {
    match message {
        Message::Mode(mode) => {
            app.dark = mode != Mode::Light;
            Task::none()
        }
        Message::WindowOpened(_) => Task::none(),
        Message::WindowClosed(id) => {
            if app.window == Some(id) {
                app.window = None;
            }
            if let Some(s) = app.session_mut() {
                s.chat.visible = false;
            }
            Task::none()
        }
        Message::Focused(on) => {
            let open = app.window.is_some();
            match app.session_mut() {
                Some(s) => {
                    s.chat.visible = on && open;
                    chat::shown(s)
                }
                None => Task::none(),
            }
        }
        Message::Resized(w) => {
            app.width = w;
            Task::none()
        }
        Message::ChatMenu(on) => {
            if let Some(s) = app.session_mut() {
                s.chat_menu = on;
            }
            Task::none()
        }
        Message::Outside(o) => outside(app, o),
        Message::Restored(Some((server, token))) => app.signed_in(server, token),
        Message::Restored(None) => {
            app.phase = Phase::Out(login::Login::new(app.config.server.clone().unwrap_or_default()));
            app.sync_tray();
            Task::none()
        }
        Message::Login(m) => match &mut app.phase {
            Phase::Out(l) => login::update(l, m),
            _ => Task::none(),
        },
        Message::SignedIn(Ok((server, token))) => {
            let keep = {
                let (server, token) = (server.clone(), token.clone());
                Task::perform(async move { vault::save(&server, &token).await }, Message::Kept)
            };
            Task::batch([app.signed_in(server, token), keep])
        }
        Message::SignedIn(Err(e)) => {
            if let Phase::Out(l) = &mut app.phase {
                l.failed(e);
            }
            Task::none()
        }
        Message::Kept(Err(e)) => app.toast(format!("{e} You'll sign in again next time.")),
        Message::Kept(Ok(())) => Task::none(),
        Message::Stream(s) => streamed(app, s),
        Message::Batch(list) => Task::batch(list.into_iter().map(Task::done)),
        Message::Ask(d) => {
            app.dialog = Some(d);
            Task::none()
        }
        Message::Answer(yes) => match app.dialog.take() {
            Some(d) if yes => update(app, d.on),
            _ => Task::none(),
        },
        Message::Shortcut(key) => match app.session().and_then(|s| shell::shortcut(s, &key)) {
            Some(r) => update(app, Message::Go(r)),
            None => Task::none(),
        },
        Message::Go(route) => {
            let Phase::In(s) = &mut app.phase else { return Task::none() };
            s.route = route.clone();
            s.chat_menu = false;
            pages::opened(s, &route)
        }
        Message::Chat(m) => {
            let Phase::In(s) = &mut app.phase else { return Task::none() };
            chat::update(s, m)
        }
        Message::Page(m) => pages::update(app, m),
        Message::Loaded(l) => loaded(app, l),
        Message::Toast(t) => app.toast(t),
        Message::ToastGone(id) => {
            if app.toast.as_ref().is_some_and(|(i, _)| *i == id) {
                app.toast = None;
            }
            Task::none()
        }
        Message::Link(url) => {
            open_link(&url);
            Task::none()
        }
        Message::Copy(t) => Task::batch([iced::clipboard::write(t), app.toast("Copied.".into())]),
        Message::Retry => {
            if let Phase::In(s) = &mut app.phase {
                s.generation += 1;
            }
            Task::none()
        }
        Message::DownCheck(n) => {
            if let Phase::In(s) = &mut app.phase
                && s.down == n
                && !s.store.connected
            {
                s.unreachable = true;
            }
            Task::none()
        }
        Message::SetPaused(on) => {
            let Some(s) = app.session() else { return Task::none() };
            let path = if on { "/pause-all" } else { "/resume" };
            s.fire(move |api| async move { api.post_empty(path).await })
        }
        Message::SignOut | Message::Unauthorized => app.sign_out(),
        Message::Nothing => Task::none(),
    }
}

fn outside(app: &mut App, o: Outside) -> Task<Message> {
    match o {
        Outside::Open => app.open_window(),
        Outside::Show(page) => {
            if app.session().is_none() {
                app.start = Some(page);
                return app.open_window();
            }
            let go = pages::link(&page).unwrap_or_default().into_iter().map(Task::done);
            Task::batch(std::iter::once(app.open_window()).chain(go))
        }
        Outside::Quit => {
            if let Some(a) = app.agent.take() {
                a.shutdown();
            }
            if let Some(b) = app.banner.take() {
                b.stop();
            }
            iced::exit()
        }
        Outside::Pause(on) => update(app, Message::SetPaused(on)),
        Outside::StopComputer => {
            if let Some(a) = &app.agent {
                a.stop_task();
            }
            Task::none()
        }
        Outside::Agent(state) => {
            // Only the brain switches it off behind the app's back; remember that as the owner's choice.
            if !state.status.enabled && app.config.computer_enabled && app.agent_state.status.enabled {
                app.config.computer_enabled = false;
                vault::save_config(&app.config);
            }
            app.agent_state = state;
            app.sync_banner();
            app.sync_tray();
            Task::none()
        }
        Outside::Notice { key, action } => {
            let Phase::In(s) = &mut app.phase else { return app.open_window() };
            let Some(n) = s.noticed.get(&key).cloned() else { return app.open_window() };
            match n.reply(&action) {
                Reply::Call { path, body } => {
                    s.noticed.remove(&key);
                    s.call(
                        move |api| async move { api.post::<serde_json::Value, _>(&path, &body).await },
                        |r| match r {
                            Ok(_) => Message::Nothing,
                            Err(e) => failed(e),
                        },
                    )
                }
                Reply::Open(target) => {
                    s.route = match target {
                        Target::Task(id) => Route::Task(id),
                        Target::Approval(_) | Target::Question(_) => Route::Chat,
                    };
                    let route = s.route.clone();
                    Task::batch([app.open_window(), update(app, Message::Go(route))])
                }
            }
        }
    }
}

fn streamed(app: &mut App, ev: Streamed) -> Task<Message> {
    let window_open = app.window.is_some();
    let Phase::In(s) = &mut app.phase else { return Task::none() };
    let task = match ev {
        Streamed::Open { reconnected } => {
            s.store.connected = true;
            s.unreachable = false;
            s.awaiting_snapshot = true;
            let mut t = vec![chat::load_page(s)];
            if reconnected {
                t.push(pages::reconnected(s));
            }
            Task::batch(t)
        }
        Streamed::Closed => {
            s.store.connected = false;
            s.down += 1;
            let n = s.down;
            Task::future(async move {
                tokio::time::sleep(Duration::from_secs(4)).await;
                Message::DownCheck(n)
            })
        }
        Streamed::Unauthorized => return app.sign_out(),
        Streamed::Event(e) => {
            let mut t = Vec::new();
            if s.awaiting_snapshot {
                s.awaiting_snapshot = false;
                if !matches!(*e, Event::Snapshot(_)) {
                    t.push(load_live(s));
                }
            }
            let before = task_before(s, &e);
            let snapshot = matches!(*e, Event::Snapshot(_));
            let page_event = pages::event_hint(&e);
            for fx in s.store.apply(*e.clone()) {
                t.push(effect(s, fx));
            }
            if let Some(before) = before {
                notice_task(s, before, &e, window_open);
            }
            if snapshot {
                t.push(load_chats(s));
            }
            t.push(pages::on_event(s, page_event));
            t.push(chat::after_event(s));
            Task::batch(t)
        }
    };
    sync_notices(app);
    app.sync_tray();
    task
}

/// A task as it was before the event: to tell when one has just ended.
fn task_before(s: &Session, e: &Event) -> Option<Option<AgentTask>> {
    match e {
        Event::TaskUpdated { task } => Some(s.store.tasks.get(&task.id).cloned()),
        _ => None,
    }
}

fn notice_task(s: &mut Session, before: Option<AgentTask>, e: &Event, window_open: bool) {
    let Event::TaskUpdated { task } = e else { return };
    // Its own chat, open in front of you, already shows it.
    let in_view = window_open && s.route == Route::Chat && task.conversation_id == Some(s.store.conversation_id);
    if notify::task_ended(before.as_ref(), task) && !in_view {
        let n = Notice::TaskEnded(task.clone());
        notices::show(n.shown(&s.store.bot_name(Some(&task.bot_id))), false);
    }
}

/// What waits on you shows as a notification once, and goes when it's answered anywhere.
fn sync_notices(app: &mut App) {
    let Phase::In(s) = &mut app.phase else { return };
    let mut open: Vec<Notice> = Vec::new();
    for a in s.store.pending_approvals() {
        open.push(Notice::Approval(a.clone()));
    }
    for q in s.store.pending_questions() {
        open.push(Notice::Question(q.clone()));
    }
    let keys: Vec<String> = open.iter().map(Notice::key).collect();
    let gone: Vec<String> = s.noticed.keys().filter(|k| !keys.contains(k)).cloned().collect();
    for k in gone {
        s.noticed.remove(&k);
        notices::close(&k);
    }
    for n in open {
        let key = n.key();
        if s.seen.contains_key(&key) {
            s.noticed.entry(key).or_insert(n);
            continue;
        }
        s.seen.insert(key.clone(), ());
        let bot = match &n {
            Notice::Approval(a) => s.store.bot_name(Some(&a.bot_id)),
            Notice::Question(q) => s.store.bot_name(Some(&q.bot_id)),
            Notice::TaskEnded(t) => s.store.bot_name(Some(&t.bot_id)),
        };
        notices::show(n.shown(&bot), true);
        s.noticed.insert(key, n);
    }
}

fn effect(s: &mut Session, fx: Effect) -> Task<Message> {
    match fx {
        Effect::RefreshConversations => load_chats(s),
        Effect::LoadThread => chat::load_page(s),
        Effect::RefreshTasks => refresh_tasks(s),
        Effect::Toast(t) => Task::done(Message::Toast(t)),
    }
}

fn loaded(app: &mut App, l: Loaded) -> Task<Message> {
    let Phase::In(s) = &mut app.phase else { return Task::none() };
    match l {
        Loaded::Chats(bots, chats) => {
            s.store.take_bots(bots);
            s.store.conversations = chats;
            let task = chat::chats_loaded(s);
            app.sync_tray();
            task
        }
        Loaded::Live { approvals, questions, desktop, unread } => {
            s.store.take_live(approvals, questions.unwrap_or_default(), desktop, unread.unwrap_or_default());
            sync_notices(app);
            app.sync_tray();
            Task::none()
        }
        Loaded::Plugins(list) => {
            s.plugins = Some(list);
            Task::none()
        }
        Loaded::Cards(list) => {
            for t in list {
                s.store.take_task(t);
            }
            Task::none()
        }
        Loaded::Settings(settings) => {
            s.settings = Some(settings);
            Task::none()
        }
    }
}

pub fn load_chats(s: &Session) -> Task<Message> {
    s.call(
        |api| async move {
            let bots: Vec<Bot> = api.get("/bots").await?;
            let chats: Vec<Conversation> = api.get("/conversations").await?;
            Ok((bots, chats))
        },
        |r| match r {
            Ok((b, c)) => Message::Loaded(Loaded::Chats(b, c)),
            Err(e) if e.is_unauthorized() => Message::Unauthorized,
            Err(_) => Message::Nothing,
        },
    )
}

fn load_plugins(s: &Session) -> Task<Message> {
    s.call(
        |api| async move { api.get::<Vec<PluginName>>("/plugins").await },
        |r| r.map(|l| Message::Loaded(Loaded::Plugins(l))).unwrap_or(Message::Nothing),
    )
}

pub fn load_settings(s: &Session) -> Task<Message> {
    s.call(
        |api| async move { api.get::<AppSettings>("/settings").await },
        |r| r.map(|l| Message::Loaded(Loaded::Settings(l))).unwrap_or(Message::Nothing),
    )
}

/// An older brain opens its stream with no snapshot: what's live is asked for instead.
fn load_live(s: &Session) -> Task<Message> {
    s.call(
        |api| async move {
            let approvals: Vec<Approval> = api.get("/approvals?pending=1").await?;
            let questions = api.get::<Vec<Question>>("/questions").await.ok();
            let desktop = api.get::<DesktopState>("/desktop/status").await.ok();
            let unread = api.get::<Vec<i64>>("/thread/unread").await.ok();
            Ok(Loaded::Live { approvals, questions, desktop, unread })
        },
        |r| r.map(Message::Loaded).unwrap_or_else(failed),
    )
}

/// After time away: the running tasks as they are now.
fn refresh_tasks(s: &Session) -> Task<Message> {
    let ids: Vec<i64> = s.store.tasks.values().filter(|t| t.status.is_active()).map(|t| t.id).collect();
    load_cards(s, ids)
}

pub fn load_cards(s: &Session, ids: Vec<i64>) -> Task<Message> {
    if ids.is_empty() {
        return Task::none();
    }
    let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    s.call(
        move |api| async move { api.get::<Vec<AgentTask>>(&format!("/tasks?ids={list}&view=card")).await },
        |r| r.map(|l| Message::Loaded(Loaded::Cards(l))).unwrap_or(Message::Nothing),
    )
}

pub fn open_link(url: &str) {
    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
        let _ = std::process::Command::new("xdg-open")
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

#[derive(Hash, Clone)]
struct StreamKey {
    server: String,
    token: String,
    generation: u64,
}

fn stream(key: &StreamKey) -> impl futures::Stream<Item = Message> + use<> {
    let key = key.clone();
    iced::stream::channel(64, async move |mut out: futures::channel::mpsc::Sender<Message>| {
        let api = Api::new(&key.server, Some(key.token.clone()));
        let (tx, mut rx) = futures::channel::mpsc::channel(64);
        let (_keep, outgoing) = futures::channel::mpsc::channel::<String>(1);
        let run = socket::run(api, "/stream".into(), tx, outgoing, Duration::from_secs(30));
        let forward = async move {
            while let Some(e) = rx.next().await {
                let m = match e {
                    SocketEvent::Open { reconnected } => Streamed::Open { reconnected },
                    SocketEvent::Text(t) => Streamed::Event(Box::new(Event::parse(&t))),
                    SocketEvent::Binary(_) => continue,
                    SocketEvent::Closed => Streamed::Closed,
                    SocketEvent::Unauthorized => Streamed::Unauthorized,
                };
                if out.send(Message::Stream(m)).await.is_err() {
                    break;
                }
            }
        };
        futures::join!(run, forward);
    })
}

pub fn subscription(app: &App) -> Subscription<Message> {
    let mut subs = vec![
        iced::system::theme_changes().map(Message::Mode),
        inbox::subscription().map(Message::Outside),
        window::close_events().map(Message::WindowClosed),
        window::events().filter_map(|(_, e)| match e {
            window::Event::Focused => Some(Message::Focused(true)),
            window::Event::Unfocused => Some(Message::Focused(false)),
            window::Event::Opened { size, .. } | window::Event::Resized(size) => Some(Message::Resized(size.width)),
            _ => None,
        }),
    ];
    if let Some(s) = app.session() {
        subs.push(Subscription::run_with(
            StreamKey {
                server: s.api.server.clone(),
                token: s.api.token.clone().unwrap_or_default(),
                generation: s.generation,
            },
            stream,
        ));
        if app.window.is_some() {
            subs.push(pages::subscription(s));
            // A message about to send counts down.
            if s.store.approvals.values().any(|a| a.status == ApprovalStatus::Sending) {
                subs.push(iced::time::every(std::time::Duration::from_secs(1)).map(|_| Message::Nothing));
            }
            // While typing into the live view, keys belong to the desktop.
            if !pages::live::typing(s) {
                subs.push(iced::keyboard::listen().filter_map(|e| match e {
                    iced::keyboard::Event::KeyPressed { key: iced::keyboard::Key::Character(c), modifiers, .. }
                        if modifiers.command() =>
                    {
                        Some(Message::Shortcut(c.to_string()))
                    }
                    _ => None,
                }));
            }
        }
    }
    Subscription::batch(subs)
}

pub fn theme(app: &App, _: window::Id) -> Option<Theme> {
    Some(theme::theme(app.dark))
}

pub fn title(app: &App, _: window::Id) -> String {
    match app.session() {
        Some(s) if s.store.needs_you() > 0 => format!("Hatbot ({})", s.store.needs_you()),
        _ => "Hatbot".into(),
    }
}

pub fn view(app: &App, _: window::Id) -> Element<'_, Message> {
    let body: Element<'_, Message> = match &app.phase {
        Phase::Starting => container(text("")).into(),
        Phase::Out(l) => login::view(l).map(Message::Login),
        Phase::In(s) => shell::view(app, s),
    };
    let with_toast = match &app.toast {
        Some((_, t)) => iced::widget::stack![
            body,
            container(container(text(t.as_str()).size(theme::FS_MD)).padding([12, 16]).style(theme::toast))
                .align_bottom(Length::Fill)
                .center_x(Length::Fill)
                .padding(24)
        ]
        .into(),
        None => body,
    };
    let with_toast = match &app.dialog {
        Some(d) => iced::widget::stack![with_toast, confirm::view(d)].into(),
        None => with_toast,
    };
    container(with_toast).width(Length::Fill).height(Length::Fill).style(theme::bar).into()
}
