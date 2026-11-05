// The app between windows: the sign-in, the event stream and what it notifies, the agent, the tray and
// the banner. Everything reaches it as a `Msg`, one at a time; what takes long runs beside it and
// answers with another.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use futures::StreamExt;
use serde::Serialize;
use tauri::async_runtime::{self, JoinHandle};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::core::api::{Api, ApiError};
use crate::core::links::web_path;
use crate::core::models::{AppLink, Event, Me, Task};
use crate::core::notify::{Notice, Reply};
use crate::core::socket::{self, SocketEvent};
use crate::core::vault::{self, Config};
use crate::core::watch::Watch;
use crate::core::{local, session};
use crate::desk::{banner, keyring, notices, tray};
use crate::window;

#[derive(Debug)]
pub enum Msg {
    Restored(Option<(String, String)>),
    /// Open the window, at a page of the web app.
    Open(Option<String>),
    /// What `hatbot` was started with again.
    Args(Vec<String>),
    /// A `hatbot-app://` link from the web app in the window.
    FromPage(String),
    Do(Action),
    SignedIn(Result<(String, String), String>),
    SetUpStep(String),
    SetUp(Result<(String, String), String>),
    Linked(Result<String, ApiError>),
    Notice {
        key: String,
        action: String,
    },
    Pause(bool),
    StopComputer,
    /// Whether a password is set, which other devices sign in with.
    LanAfter(bool),
    LanSet(Result<Option<String>, String>),
    Agent(AgentState),
    Stream(u64, SocketEvent),
    Tasks(u64, Vec<Task>),
    Failed(String),
    Quit,
}

/// What the app's own pages ask for.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "do", rename_all = "camelCase")]
pub enum Action {
    RunHere,
    ConnectElsewhere,
    Back,
    SignIn { address: String, password: String, code: String },
    ComputerEnabled { on: bool },
    ComputerPaused { on: bool },
    StopComputer,
    Lan { on: bool },
    OpenHatbot,
    OpenComputer,
}

static TX: OnceLock<mpsc::UnboundedSender<Msg>> = OnceLock::new();

pub fn send(m: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(m);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    /// Connected to the brain.
    pub online: bool,
    pub status: hatbot_agent::protocol::ComputerStatus,
}

impl AgentState {
    /// A task holds the screen.
    pub fn using(&self) -> bool {
        self.status.screen.is_some()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Starting,
    Welcome,
    Login,
    SettingUp,
    In,
}

/// What the app's pages show; sent as "state" whenever it changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub phase: Phase,
    pub platform: &'static str,
    pub server: Option<String>,
    pub local: bool,
    /// The web app's address on the network, while other devices may use the brain here.
    pub lan: Option<String>,
    pub step: Option<String>,
    pub error: Option<String>,
    pub busy: bool,
    pub computer_enabled: bool,
    pub agent: AgentState,
}

pub type Shared = Arc<Mutex<UiState>>;

struct Session {
    api: Api,
    stream: JoinHandle<()>,
    generation: u64,
}

pub struct Daemon {
    app: AppHandle,
    shared: Shared,
    config: Config,
    ui: UiState,
    session: Option<Session>,
    generation: u64,
    watch: Watch,
    noticed: HashMap<String, Notice>,
    /// Tasks told as ended, for their notification's Open.
    ended: HashMap<String, Notice>,
    seen: HashSet<String>,
    agent: Option<hatbot_agent::AgentHandle>,
    banner: Option<banner::Banner>,
    /// Where the window goes once signed in.
    start: Option<String>,
}

pub fn start(app: AppHandle, shared: Shared, open_window: bool, page: Option<String>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _ = TX.set(tx);
    let config = vault::load_config();
    let mut d = Daemon {
        app,
        shared,
        ui: UiState {
            platform: crate::core::OS,
            server: config.server.clone(),
            local: config.local,
            computer_enabled: config.computer_enabled,
            ..Default::default()
        },
        config,
        session: None,
        generation: 0,
        watch: Watch::default(),
        noticed: HashMap::new(),
        ended: HashMap::new(),
        seen: HashSet::new(),
        agent: None,
        banner: None,
        start: page,
    };
    let config = d.config.clone();
    async_runtime::spawn(async move {
        let restored = async {
            if config.local {
                let p = local::paths();
                return Some((local::server(&p)?, local::token(&p)?));
            }
            let server = config.server?;
            let token = keyring::load(&server).await?;
            Some((server, token))
        };
        send(Msg::Restored(restored.await));
    });
    if open_window {
        window::open_local(&d.app);
    }
    async_runtime::spawn(async move {
        tray::start(&d.app).await;
        while let Some(m) = rx.recv().await {
            d.handle(m);
        }
    });
}

impl Daemon {
    fn handle(&mut self, m: Msg) {
        match m {
            Msg::Restored(Some((server, token))) => self.signed_in(server, token, false),
            Msg::Restored(None) => {
                self.ui.phase = if self.config.server.is_some() { Phase::Login } else { Phase::Welcome };
                self.publish();
                if self.start.is_some() {
                    window::open_local(&self.app);
                }
            }
            Msg::Open(page) => self.open(page),
            Msg::Args(args) => {
                if !args.iter().any(|a| a == "--daemon") {
                    self.open(page_of(&args));
                }
            }
            Msg::FromPage(what) => match what.as_str() {
                "signed-out" => self.relink(),
                "sign-out" => self.sign_out(),
                "computer" => window::open_computer(&self.app),
                _ => {}
            },
            Msg::Do(a) => self.act(a),
            Msg::SignedIn(Ok((server, token))) => {
                let (s, t) = (server.clone(), token.clone());
                async_runtime::spawn(async move {
                    if let Err(e) = keyring::save(&s, &t).await {
                        send(Msg::Failed(e));
                    }
                });
                self.signed_in(server, token, true);
            }
            Msg::SignedIn(Err(e)) | Msg::SetUp(Err(e)) => {
                self.ui.busy = false;
                self.ui.step = None;
                self.ui.error = Some(e);
                if self.ui.phase == Phase::SettingUp {
                    self.ui.phase = Phase::Welcome;
                }
                self.publish();
            }
            Msg::SetUpStep(step) => {
                self.ui.step = Some(step);
                self.publish();
            }
            Msg::SetUp(Ok((server, token))) => {
                self.config.local = true;
                self.ui.local = true;
                self.start = Some("/setup".into());
                self.signed_in(server, token, true);
            }
            Msg::Linked(Ok(url)) => window::load(&self.app, &url),
            Msg::Linked(Err(e)) if e.is_unauthorized() => self.sign_out(),
            Msg::Linked(Err(e)) => notices::tell(&e.message),
            Msg::Failed(e) => {
                self.ui.busy = false;
                self.publish();
                notices::tell(&e);
            }
            Msg::Notice { key, action } => self.notice(key, action),
            Msg::Pause(on) => {
                let path = if on { "/pause-all" } else { "/resume" };
                self.call(move |api| async move { api.post_empty(path).await });
            }
            Msg::StopComputer => {
                if let Some(a) = &self.agent {
                    a.stop_task();
                }
            }
            Msg::LanAfter(true) => {
                async_runtime::spawn(async move { send(Msg::LanSet(local::set_lan(true).await)) });
            }
            Msg::LanAfter(false) => {
                self.ui.busy = false;
                self.ui.error =
                    Some("Set a password first. Other devices sign in with it and an authenticator code.".into());
                self.publish();
                self.open(Some("/setup".into()));
            }
            Msg::LanSet(r) => {
                self.ui.busy = false;
                match r {
                    Ok(lan) => self.ui.lan = lan,
                    Err(e) => self.ui.error = Some(e),
                }
                self.publish();
            }
            Msg::Agent(state) => {
                // Only the brain switches it off behind the app's back; remember that as the owner's choice.
                if !state.status.enabled && self.config.computer_enabled && self.ui.agent.status.enabled {
                    self.set_computer_enabled(false);
                }
                self.ui.agent = state;
                self.sync_banner();
                self.sync_tray();
                self.publish();
            }
            Msg::Stream(generation, ev) => {
                if self.session.as_ref().is_some_and(|s| s.generation == generation) {
                    self.streamed(generation, ev);
                }
            }
            Msg::Tasks(generation, tasks) => {
                if self.session.as_ref().is_some_and(|s| s.generation == generation) {
                    self.watch.take_tasks(tasks);
                }
            }
            Msg::Quit => {
                if let Some(a) = self.agent.take() {
                    a.shutdown();
                }
                self.banner.take();
                for key in self.noticed.keys() {
                    notices::close(key);
                }
                self.app.exit(0);
            }
        }
    }

    fn act(&mut self, a: Action) {
        self.ui.error = None;
        match a {
            Action::ConnectElsewhere => self.ui.phase = Phase::Login,
            Action::Back => self.ui.phase = Phase::Welcome,
            Action::RunHere => {
                self.ui.phase = Phase::SettingUp;
                self.ui.step = Some("Getting ready".into());
                async_runtime::spawn(async {
                    let r = local::set_up(|s| send(Msg::SetUpStep(s.to_string()))).await;
                    send(Msg::SetUp(r));
                });
            }
            Action::SignIn { address, password, code } => {
                self.ui.busy = true;
                async_runtime::spawn(async move {
                    let r = session::sign_in(&address, &password, &code, &session::device_name()).await;
                    send(Msg::SignedIn(r.map_err(|e| e.message)));
                });
            }
            Action::ComputerEnabled { on } => self.set_computer_enabled(on),
            Action::ComputerPaused { on } => {
                if let Some(a) = &self.agent {
                    if on { a.pause() } else { a.resume() }
                }
            }
            Action::StopComputer => send(Msg::StopComputer),
            Action::Lan { on: true } => {
                self.ui.busy = true;
                self.call(|api| async move {
                    send(Msg::LanAfter(api.get::<Me>("/auth/me").await?.setup_done));
                    Ok(())
                });
            }
            Action::Lan { on: false } => {
                self.ui.busy = true;
                async_runtime::spawn(async { send(Msg::LanSet(local::set_lan(false).await)) });
            }
            Action::OpenHatbot => self.open(None),
            Action::OpenComputer => window::open_computer(&self.app),
        }
        self.publish();
    }

    fn publish(&mut self) {
        let mut shared = self.shared.lock().unwrap();
        if *shared != self.ui {
            *shared = self.ui.clone();
            let _ = self.app.emit("state", &self.ui);
        }
    }

    fn open(&mut self, page: Option<String>) {
        if self.ui.phase != Phase::In {
            self.start = page.or(self.start.take());
            window::open_local(&self.app);
            return;
        }
        let Some(s) = &self.session else { return };
        window::go(&self.app, &s.api.server, &page.unwrap_or_else(|| "/".into()));
    }

    /// The window's web app has no session (a first open, or it ran out): one from the app's token.
    fn relink(&mut self) {
        let to = window::web_page(&self.app).unwrap_or_else(|| "/".into());
        self.link(to);
    }

    fn link(&mut self, to: String) {
        self.call(move |api| async move {
            let r = api.post::<AppLink, _>("/auth/link", &serde_json::json!({})).await;
            send(Msg::Linked(r.map(|l| format!("{}?to={}", l.url, escape(&to)))));
            Ok(())
        });
    }

    fn call<F, Fut>(&self, f: F)
    where
        F: FnOnce(Api) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), ApiError>> + Send,
    {
        let Some(s) = &self.session else { return };
        let api = s.api.clone();
        async_runtime::spawn(async move {
            if let Err(e) = f(api).await {
                send(if e.is_unauthorized() { Msg::FromPage("sign-out".into()) } else { Msg::Failed(e.message) });
            }
        });
    }

    fn signed_in(&mut self, server: String, token: String, fresh: bool) {
        self.config.server = Some(server.clone());
        vault::save_config(&self.config);
        self.generation += 1;
        let generation = self.generation;
        let api = Api::new(&server, Some(token));
        let stream_api = api.clone();
        let stream = async_runtime::spawn(async move {
            let (tx, rx) = futures::channel::mpsc::channel(64);
            let (_out, outgoing) = futures::channel::mpsc::channel(1);
            let run = socket::run(stream_api, "/stream".into(), tx, outgoing, std::time::Duration::from_secs(30));
            let forward = rx.for_each(|ev| async move { send(Msg::Stream(generation, ev)) });
            futures::join!(run, forward);
        });
        window::set_brain(Some(&server));
        self.session = Some(Session { api, stream, generation });
        self.ui.phase = Phase::In;
        self.ui.server = Some(server);
        self.ui.busy = false;
        self.ui.step = None;
        self.ui.lan = if self.config.local { local::lan() } else { None };
        self.start_agent();
        self.sync_tray();
        self.publish();
        let start = self.start.take();
        if fresh {
            self.link(start.unwrap_or_else(|| "/".into()));
        } else if start.is_some() || window::is_open(&self.app) {
            self.open(start);
        }
        if self.config.local && !fresh {
            async_runtime::spawn(async {
                match local::update().await {
                    Ok(true) => notices::tell("Hatbot on this computer is updated."),
                    Ok(false) => {}
                    Err(e) => notices::tell(&e),
                }
            });
        }
    }

    fn sign_out(&mut self) {
        if let Some(a) = self.agent.take() {
            a.shutdown();
        }
        window::set_brain(None);
        if let Some(s) = self.session.take() {
            s.stream.abort();
            // The brain on this computer keeps its token for Run it here; a server's is revoked.
            if !self.config.local {
                let (api, server) = (s.api.clone(), s.api.server.clone());
                async_runtime::spawn(async move {
                    let _ = api.post_empty("/auth/logout").await;
                    keyring::clear(&server).await;
                });
            }
        }
        for key in self.noticed.keys() {
            notices::close(key);
        }
        self.noticed.clear();
        self.ended.clear();
        self.watch = Watch::default();
        self.ui.agent = AgentState::default();
        self.ui.phase = if self.config.local { Phase::Welcome } else { Phase::Login };
        self.config.local = false;
        self.ui.local = false;
        self.ui.lan = None;
        vault::save_config(&self.config);
        self.sync_banner();
        self.sync_tray();
        self.publish();
        if window::is_open(&self.app) {
            window::reopen_local(&self.app);
        }
    }

    fn start_agent(&mut self) {
        let Some(s) = &self.session else { return };
        if self.agent.is_some() {
            return;
        }
        let handle = hatbot_agent::Agent::start(hatbot_agent::AgentConfig {
            brain_url: s.api.server.clone(),
            device_token: s.api.token.clone().unwrap_or_default(),
            enabled: self.config.computer_enabled,
        });
        let (mut status, mut connection) = (handle.status(), handle.connection());
        async_runtime::spawn(async move {
            loop {
                send(Msg::Agent(AgentState {
                    online: *connection.borrow_and_update() == hatbot_agent::Connection::Connected,
                    status: status.borrow_and_update().clone(),
                }));
                tokio::select! {
                    r = status.changed() => if r.is_err() { break },
                    r = connection.changed() => if r.is_err() { break },
                }
            }
        });
        self.agent = Some(handle);
    }

    fn set_computer_enabled(&mut self, on: bool) {
        self.config.computer_enabled = on;
        self.ui.computer_enabled = on;
        vault::save_config(&self.config);
        if let Some(a) = &self.agent {
            a.set_enabled(on);
        }
    }

    fn sync_tray(&self) {
        tray::set(tray::Tray {
            signed_in: self.session.is_some(),
            needs_you: self.noticed.len(),
            paused: self.watch.paused,
            using_computer: self.ui.agent.using(),
        });
    }

    fn sync_banner(&mut self) {
        let using = self.ui.agent.using();
        if using && self.banner.is_none() {
            let output = self.ui.agent.status.screen.as_ref().map(|s| s.output.clone());
            self.banner = banner::Banner::show(&self.app, output);
        } else if !using {
            self.banner.take();
        }
    }

    fn streamed(&mut self, generation: u64, ev: SocketEvent) {
        match ev {
            SocketEvent::Open { .. } => self.call(move |api| async move {
                let tasks: Vec<Task> = api.get("/tasks?status=active&view=card&limit=200").await?;
                send(Msg::Tasks(generation, tasks));
                Ok(())
            }),
            SocketEvent::Text(text) => {
                if let Some(task) = self.watch.apply(Event::parse(&text))
                    && !window::is_focused(&self.app)
                {
                    let n = Notice::TaskEnded(task);
                    notices::show(n.shown(&self.watch.bot_name(n.bot_id())), false);
                    self.ended.insert(n.key(), n);
                }
                self.sync_notices();
                self.sync_tray();
            }
            SocketEvent::Unauthorized => self.sign_out(),
            SocketEvent::Binary(_) | SocketEvent::Closed => {}
        }
    }

    /// What waits on you shows as a notification once, and goes when it's answered anywhere.
    fn sync_notices(&mut self) {
        let open = self.watch.open();
        let keys: HashSet<String> = open.iter().map(Notice::key).collect();
        self.noticed.retain(|k, _| {
            let keep = keys.contains(k);
            if !keep {
                notices::close(k);
            }
            keep
        });
        for n in open {
            let key = n.key();
            if self.seen.insert(key.clone()) {
                notices::show(n.shown(&self.watch.bot_name(n.bot_id())), true);
            }
            self.noticed.entry(key).or_insert(n);
        }
    }

    fn notice(&mut self, key: String, action: String) {
        let Some(n) = self.noticed.get(&key).or(self.ended.get(&key)).cloned() else { return self.open(None) };
        match n.reply(&action) {
            Reply::Call { path, body } => {
                self.noticed.remove(&key);
                self.call(move |api| async move { api.post_unit(&path, &body).await });
            }
            Reply::Open(target) => self.open(Some(target.0)),
        }
    }
}

/// The page `hatbot --open <page>` or a `hatbot://` link asks for.
pub fn page_of(args: &[String]) -> Option<String> {
    args.iter()
        .position(|a| a == "--open")
        .and_then(|i| args.get(i + 1))
        .or_else(|| args.iter().find(|a| a.starts_with("hatbot://")))
        .map(|p| web_path(p))
}

fn escape(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
