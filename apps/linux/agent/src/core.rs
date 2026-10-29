//! The agent's state and what it does for each request, against a [`Computer`].

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use evdev::KeyCode;
use image::RgbImage;
use image::imageops::FilterType;
use serde_json::{Map, Value};
use tokio::sync::watch;
use tokio::time::{Instant, sleep};

use crate::activity::Activity;
use crate::computer::{Button, Clip, Computer, Frame, InspectAt, Output, SessionEvent, Window};
use crate::human::{between, key_gap, path};
use crate::keys::{self, Combo, Key, Modifier};
use crate::protocol::{
    ActionName, ActionResult, ComputerResult, ComputerScreen, ComputerStatus, ComputerWindow,
    ErrorCode, LiveInput, Request,
};
use crate::scale::Scaling;
use crate::typing::{self, KeyTable, Stroke, TypePlan};
use crate::{files, shell};

/// Longer text than this is typed fast, in chunks this long, as on the desktop.
const HUMAN_TYPING_CHARS: usize = 200;
/// Live frame rates: while the owner has control, and while they only watch.
pub const LIVE_FPS_CONTROL: u32 = 15;
pub const LIVE_FPS_WATCHING: u32 = 5;
/// The owner has control from Live while their input keeps coming this often.
const LIVE_CONTROL_HOLD: Duration = Duration::from_secs(3);
const SCREENSHOT_QUALITY: u8 = 85;
const LIVE_QUALITY: u8 = 65;

#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: ErrorCode,
    pub error: String,
}

impl Refusal {
    pub fn new(code: ErrorCode, error: impl Into<String>) -> Self {
        Self { code, error: error.into() }
    }
}

impl From<String> for Refusal {
    fn from(error: String) -> Self {
        Self::new(ErrorCode::Failed, error)
    }
}

impl From<keys::KeyError> for Refusal {
    fn from(e: keys::KeyError) -> Self {
        Self::new(ErrorCode::Failed, e.0)
    }
}

type Res<T> = Result<T, Refusal>;

/// The monitor a task took, kept until it lets it go.
#[derive(Debug, Clone)]
struct Claim {
    task_id: String,
    output: Output,
}

#[derive(Debug, Default)]
struct State {
    enabled: bool,
    paused: bool,
    locked: bool,
    activity: Activity,
    claim: Option<Claim>,
    live_control_until: Option<Instant>,
}

/// Where the agent last put the pointer, in a monitor's logical pixels. The compositor doesn't say
/// where it is, so this is the best guess.
#[derive(Debug, Default)]
struct Pointer {
    at: Option<(String, f64, f64)>,
}

pub struct Core {
    pub computer: Arc<dyn Computer>,
    state: Mutex<State>,
    status: watch::Sender<ComputerStatus>,
    pub live: watch::Sender<bool>,
    /// One input at a time, in order.
    input: tokio::sync::Mutex<Pointer>,
}

impl Core {
    pub fn new(computer: Arc<dyn Computer>, enabled: bool) -> Self {
        let state = State { enabled, ..Default::default() };
        let (status, _) = watch::channel(ComputerStatus { enabled, ..Default::default() });
        let (live, _) = watch::channel(false);
        Self { computer, state: Mutex::new(state), status, live, input: Default::default() }
    }

    pub fn subscribe(&self) -> watch::Receiver<ComputerStatus> {
        self.status.subscribe()
    }

    pub fn status(&self) -> ComputerStatus {
        self.status.borrow().clone()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("state lock")
    }

    fn publish(&self) {
        let s = self.state();
        let next = ComputerStatus {
            enabled: s.enabled,
            locked: s.locked,
            owner_active: s.activity.owner_active(),
            paused: s.paused,
            screen: s.claim.as_ref().map(|c| screen(&c.output)),
        };
        drop(s);
        self.status.send_if_modified(|cur| {
            let changed = *cur != next;
            *cur = next;
            changed
        });
    }

    pub fn set_enabled(&self, on: bool) {
        let mut s = self.state();
        s.enabled = on;
        if !on {
            s.claim = None;
        }
        drop(s);
        if !on {
            self.live.send_replace(false);
        }
        self.publish();
    }

    pub fn set_paused(&self, on: bool) {
        self.state().paused = on;
        self.publish();
    }

    /// The brain went away: no task has the screen any more, and nobody watches.
    pub fn disconnected(&self) {
        self.state().claim = None;
        self.live.send_replace(false);
        self.publish();
    }

    pub fn session_event(&self, ev: SessionEvent) {
        let mut s = self.state();
        match ev {
            SessionEvent::Locked(on) => s.locked = on,
            SessionEvent::Resumed => {
                s.activity.resumed(Instant::now());
            }
            SessionEvent::Quiet => {
                s.activity.quiet();
            }
        }
        drop(s);
        self.publish();
    }

    /// Whether the brain may ask this now.
    pub fn gate(&self, req: &Request) -> Res<()> {
        if matches!(req, Request::Status | Request::Release { .. } | Request::Unknown) {
            return Ok(());
        }
        let s = self.state();
        if !s.enabled {
            return Err(Refusal::new(
                ErrorCode::Disabled,
                "Hatbot isn't allowed to use this computer. The owner can switch it on in the Linux app.",
            ));
        }
        if s.paused {
            return Err(Refusal::new(ErrorCode::Paused, "Use of this computer is paused."));
        }
        if s.locked {
            return Err(Refusal::new(ErrorCode::Locked, "The computer is locked."));
        }
        let model_input = matches!(req, Request::FocusWindow { .. })
            || matches!(req, Request::Action { name, .. } if !matches!(name, ActionName::Wait | ActionName::CursorPosition));
        if model_input && s.activity.owner_active() {
            return Err(owner());
        }
        Ok(())
    }

    /// Before each piece of input: stop if the owner took over, and mark what follows as ours.
    fn step(&self) -> Res<()> {
        let mut s = self.state();
        if s.activity.owner_active() {
            return Err(owner());
        }
        s.activity.own_input(Instant::now());
        Ok(())
    }

    fn own_input(&self) {
        self.state().activity.own_input(Instant::now());
    }

    pub async fn handle(&self, req: Request) -> Res<ComputerResult> {
        self.gate(&req)?;
        match req {
            Request::Status => Ok(ComputerResult::Status { status: self.status() }),
            Request::Claim { task_id } => self.claim(task_id).await,
            Request::Release { task_id } => {
                let mut s = self.state();
                if s.claim.as_ref().is_some_and(|c| c.task_id == task_id) {
                    s.claim = None;
                }
                drop(s);
                self.publish();
                Ok(ComputerResult::Release)
            }
            Request::Screenshot => {
                let (out, sc) = self.screen().await?;
                let frame = self.computer.capture(out.name).await?;
                let (data, width, height) =
                    encode(&resize(&frame, sc.width, sc.height), SCREENSHOT_QUALITY);
                Ok(ComputerResult::Screenshot { data, width, height })
            }
            Request::Zoom { x, y, width, height } => self.zoom(x, y, width, height).await,
            Request::Action { name, input } => {
                let result = self.action(name, &input).await?;
                Ok(ComputerResult::Action { result })
            }
            Request::Windows => {
                let (out, sc) = self.screen().await?;
                let windows = self.windows(&out).await?;
                let frame = self.computer.capture(out.name.clone()).await.ok();
                let windows = windows
                    .into_iter()
                    .map(|w| {
                        let mut cw = ComputerWindow {
                            id: w.id,
                            title: w.title.clone(),
                            app_id: w.app_id.clone(),
                            focused: w.focused,
                            ..Default::default()
                        };
                        if let Some(r) = w.rect {
                            let (x, y) = sc.shot(r.x, r.y);
                            let (x1, y1) = sc.shot(r.x + r.width, r.y + r.height);
                            cw.x = Some(x.round() as i32);
                            cw.y = Some(y.round() as i32);
                            cw.width = Some((x1 - x).round() as i32);
                            cw.height = Some((y1 - y).round() as i32);
                            cw.hidden = frame.as_ref().map(|f| hidden(f, &out, &w));
                        }
                        cw
                    })
                    .collect();
                Ok(ComputerResult::Windows { windows })
            }
            Request::FocusWindow { id } => {
                let _input = self.input.lock().await;
                self.step()?;
                self.computer.focus_window(id).await?;
                Ok(ComputerResult::FocusWindow)
            }
            Request::Inspect { x, y } => self.inspect(x, y).await,
            Request::Exec { command, timeout_ms } => {
                let result = shell::run(&command, timeout_ms).await?;
                Ok(ComputerResult::Exec { result })
            }
            Request::PutFile { name, data, path } => {
                let path = files::put(&name, &data, path.as_deref()).await?;
                Ok(ComputerResult::PutFile { path })
            }
            Request::GetFile { path } => {
                let (name, data) = files::get(&path).await?;
                Ok(ComputerResult::GetFile { name, data })
            }
            Request::Live { on } => {
                self.live.send_replace(on);
                Ok(ComputerResult::Live)
            }
            Request::LiveInput { input } => {
                self.live_input(input).await?;
                Ok(ComputerResult::LiveInput)
            }
            Request::Unknown => {
                Err("This computer's Hatbot doesn't know that request. It may need an update."
                    .to_string()
                    .into())
            }
        }
    }

    async fn claim(&self, task_id: String) -> Res<ComputerResult> {
        if let Some(c) = &self.state().claim {
            if c.task_id != task_id {
                return Err(Refusal::new(ErrorCode::Busy, "Another task is using the screen."));
            }
            return Ok(ComputerResult::Claim { screen: screen(&c.output) });
        }
        let output = self.computer.focused_output().await?;
        let mut s = self.state();
        // Another claim may have come in while the monitor was looked up.
        if let Some(c) = &s.claim {
            if c.task_id != task_id {
                return Err(Refusal::new(ErrorCode::Busy, "Another task is using the screen."));
            }
            return Ok(ComputerResult::Claim { screen: screen(&c.output) });
        }
        s.claim = Some(Claim { task_id, output: output.clone() });
        drop(s);
        self.publish();
        Ok(ComputerResult::Claim { screen: screen(&output) })
    }

    /// The task's monitor, or the focused one when no task has taken one.
    async fn screen(&self) -> Res<(Output, Scaling)> {
        let claimed = self.state().claim.as_ref().map(|c| c.output.clone());
        let out = match claimed {
            Some(o) => o,
            None => self.computer.focused_output().await?,
        };
        let sc = Scaling::new(out.width, out.height);
        Ok((out, sc))
    }

    async fn zoom(&self, x: f64, y: f64, width: f64, height: f64) -> Res<ComputerResult> {
        let (out, sc) = self.screen().await?;
        let ok = [x, y, width, height].iter().all(|n| n.is_finite())
            && width >= 1.0
            && height >= 1.0
            && x >= 0.0
            && y >= 0.0
            && x + width <= sc.width as f64
            && y + height <= sc.height as f64;
        if !ok {
            return Err(format!(
                "The region must be inside the {}x{} screen, at least a pixel across.",
                sc.width, sc.height
            )
            .into());
        }
        let frame = self.computer.capture(out.name).await?;
        let fx = frame.width as f64 / sc.width as f64;
        let fy = frame.height as f64 / sc.height as f64;
        let crop = image::imageops::crop_imm(
            &to_image(&frame),
            (x * fx) as u32,
            (y * fy) as u32,
            ((width * fx) as u32).max(1),
            ((height * fy) as u32).max(1),
        )
        .to_image();
        let f = (sc.width as f64 / width).min(sc.height as f64 / height);
        let (ow, oh) = (((width * f).round() as u32).max(1), ((height * f).round() as u32).max(1));
        let img = image::imageops::resize(&crop, ow, oh, FilterType::Lanczos3);
        let (data, width, height) = encode(&img, SCREENSHOT_QUALITY);
        Ok(ComputerResult::Zoom { data, width, height })
    }

    async fn windows(&self, out: &Output) -> Res<Vec<Window>> {
        self.computer.windows(out.name.clone()).await?.ok_or_else(|| {
            "This computer's compositor doesn't list its windows.".to_string().into()
        })
    }

    async fn inspect(&self, x: Option<f64>, y: Option<f64>) -> Res<ComputerResult> {
        let (out, sc) = self.screen().await?;
        let windows = self.computer.windows(out.name.clone()).await?;
        let at = match (x, y) {
            (Some(x), Some(y)) => {
                let (px, py) = sc.point(x, y)?;
                let (lx, ly) = sc.logical(px, py);
                // Without window positions a point can't be found in a window's tree.
                let Some(windows) = windows else {
                    return Ok(ComputerResult::Inspect { element: None });
                };
                let mut under =
                    windows.iter().filter(|w| w.rect.is_some_and(|r| r.contains(lx, ly)));
                let hit = under.clone().find(|w| w.focused).or_else(|| under.next());
                match hit.and_then(|w| Some((w, w.pid?, w.rect?))) {
                    Some((w, pid, r)) => {
                        InspectAt::Point { pid, title: w.title.clone(), x: lx - r.x, y: ly - r.y }
                    }
                    None => return Ok(ComputerResult::Inspect { element: None }),
                }
            }
            _ => InspectAt::Focus {
                pid: windows.and_then(|ws| ws.into_iter().find(|w| w.focused)).and_then(|w| w.pid),
            },
        };
        let element = self.computer.inspect(at).await?;
        Ok(ComputerResult::Inspect { element })
    }

    async fn action(&self, name: ActionName, input: &Map<String, Value>) -> Res<ActionResult> {
        let mut pointer = self.input.lock().await;
        let (out, sc) = self.screen().await?;
        let target = match input.get("coordinate") {
            None | Some(Value::Null) => None,
            Some(v) => Some(point(&sc, v)?),
        };
        let mods = keys::read_modifiers(input.get("text").and_then(Value::as_str))
            .ok()
            .unwrap_or_default();
        let held = |name: ActionName| {
            matches!(
                name,
                ActionName::LeftClick
                    | ActionName::RightClick
                    | ActionName::MiddleClick
                    | ActionName::DoubleClick
                    | ActionName::TripleClick
                    | ActionName::Scroll
                    | ActionName::LeftClickDrag
            )
        };
        if held(name) {
            // Checked here so a bad modifier fails before anything moves.
            keys::read_modifiers(input.get("text").and_then(Value::as_str))?;
        }
        match name {
            ActionName::Key => {
                let combos = keys::read_combos(&text(input)?)?;
                let repeat = num(input, "repeat", 1.0, 1.0, 50.0)?.round() as u32;
                let table = self.table_if_needed(&combos).await?;
                for i in 0..repeat {
                    for (j, c) in combos.iter().enumerate() {
                        if i + j as u32 > 0 {
                            sleep(Duration::from_millis(40)).await;
                        }
                        self.combo(c, &table, None).await?;
                    }
                }
            }
            ActionName::HoldKey => {
                let combo = keys::read_combo(&text(input)?)?;
                let secs = num(input, "duration", 0.0, 0.0, 10.0)?;
                let table = self.table_if_needed(std::slice::from_ref(&combo)).await?;
                self.combo(&combo, &table, Some(Duration::from_secs_f64(secs))).await?;
            }
            ActionName::Type => self.type_text(&out, &text(input)?).await?,
            ActionName::CursorPosition => {
                let (x, y) = match &pointer.at {
                    Some((o, x, y)) if *o == out.name => sc.shot(*x, *y),
                    _ => (sc.width as f64 / 2.0, sc.height as f64 / 2.0),
                };
                return Ok(ActionResult {
                    x: Some(x.round() as i32),
                    y: Some(y.round() as i32),
                    text: None,
                });
            }
            ActionName::MouseMove => {
                let to =
                    target.ok_or_else(|| Refusal::from("coordinate is required.".to_string()))?;
                self.glide(&mut pointer, &out, &sc, to).await?;
            }
            ActionName::LeftMouseDown | ActionName::LeftMouseUp => {
                self.step()?;
                self.computer.button(Button::Left, name == ActionName::LeftMouseDown).await?;
            }
            ActionName::LeftClick
            | ActionName::RightClick
            | ActionName::MiddleClick
            | ActionName::DoubleClick
            | ActionName::TripleClick => {
                let (button, times) = match name {
                    ActionName::RightClick => (Button::Right, 1),
                    ActionName::MiddleClick => (Button::Middle, 1),
                    ActionName::DoubleClick => (Button::Left, 2),
                    ActionName::TripleClick => (Button::Left, 3),
                    _ => (Button::Left, 1),
                };
                if let Some(to) = target {
                    self.glide(&mut pointer, &out, &sc, to).await?;
                }
                self.hold(&mods, true).await?;
                let clicked = async {
                    for i in 0..times {
                        if i > 0 {
                            sleep(Duration::from_millis(80)).await;
                        }
                        self.step()?;
                        self.computer.button(button, true).await?;
                        sleep(Duration::from_millis(between(30, 70))).await;
                        self.step()?;
                        self.computer.button(button, false).await?;
                    }
                    Ok::<_, Refusal>(())
                }
                .await;
                self.hold(&mods, false).await?;
                clicked?;
            }
            ActionName::LeftClickDrag => {
                let from = point(&sc, input.get("start_coordinate").unwrap_or(&Value::Null))?;
                let to =
                    target.ok_or_else(|| Refusal::from("coordinate is required.".to_string()))?;
                self.move_to(&mut pointer, &out, &sc, from).await?;
                self.hold(&mods, true).await?;
                let dragged = async {
                    self.step()?;
                    self.computer.button(Button::Left, true).await?;
                    sleep(Duration::from_millis(100)).await;
                    self.move_to(
                        &mut pointer,
                        &out,
                        &sc,
                        ((from.0 + to.0) / 2.0, (from.1 + to.1) / 2.0),
                    )
                    .await?;
                    sleep(Duration::from_millis(50)).await;
                    self.move_to(&mut pointer, &out, &sc, to).await?;
                    sleep(Duration::from_millis(100)).await;
                    Ok::<_, Refusal>(())
                }
                .await;
                // Let go whatever happened, so the button isn't left down.
                self.own_input();
                let up = self.computer.button(Button::Left, false).await;
                self.hold(&mods, false).await?;
                dragged?;
                up?;
            }
            ActionName::Scroll => {
                let dir = input.get("scroll_direction").and_then(Value::as_str).unwrap_or("");
                let (dx, dy) = match dir {
                    "up" => (0, -1),
                    "down" => (0, 1),
                    "left" => (-1, 0),
                    "right" => (1, 0),
                    _ => {
                        return Err("scroll_direction must be up, down, left or right."
                            .to_string()
                            .into());
                    }
                };
                let amount = num(input, "scroll_amount", f64::NAN, 1.0, 30.0)?.round() as u32;
                if let Some(to) = target {
                    self.glide(&mut pointer, &out, &sc, to).await?;
                }
                self.hold(&mods, true).await?;
                let scrolled = async {
                    for i in 0..amount {
                        if i > 0 {
                            sleep(Duration::from_millis(30)).await;
                        }
                        self.step()?;
                        self.computer.wheel(dx, dy).await?;
                    }
                    Ok::<_, Refusal>(())
                }
                .await;
                self.hold(&mods, false).await?;
                scrolled?;
            }
            ActionName::Wait => {
                let secs = num(input, "duration", f64::NAN, 0.0, 30.0)?;
                drop(pointer);
                sleep(Duration::from_secs_f64(secs)).await;
            }
            ActionName::Unknown => return Err("Unknown action.".to_string().into()),
        }
        Ok(ActionResult::default())
    }

    /// Holds modifiers down (or lets them go, last first) around a click or scroll.
    async fn hold(&self, mods: &[Modifier], down: bool) -> Res<()> {
        if down {
            for m in mods {
                self.step()?;
                self.computer.key(m.code(), true).await?;
            }
        } else {
            self.own_input();
            for m in mods.iter().rev() {
                self.computer.key(m.code(), false).await?;
            }
        }
        Ok(())
    }

    async fn table_if_needed(&self, combos: &[Combo]) -> Res<KeyTable> {
        if combos.iter().any(|c| matches!(c.key, Some(Key::Char(_)))) {
            Ok(self.computer.key_table().await?)
        } else {
            Ok(KeyTable::default())
        }
    }

    /// Presses one combination: modifiers in order, the key, then all of them up, last first.
    async fn combo(&self, c: &Combo, table: &KeyTable, hold: Option<Duration>) -> Res<()> {
        let mut down: Vec<KeyCode> = c.mods.iter().map(|m| m.code()).collect();
        match &c.key {
            Some(Key::Named(code)) => down.push(*code),
            Some(Key::Char(ch)) => {
                let s = table.shortcut(*ch).ok_or_else(|| {
                    Refusal::from(format!("\"{ch}\" isn't on this computer's keyboard layout."))
                })?;
                if s.shift && !c.mods.contains(&Modifier::Shift) {
                    down.push(KeyCode::KEY_LEFTSHIFT);
                }
                if s.altgr {
                    down.push(KeyCode::KEY_RIGHTALT);
                }
                down.push(s.code);
            }
            Some(Key::Mod(m)) => down.push(m.code()),
            None => {}
        }
        self.press(&down, Some(hold.unwrap_or(Duration::from_millis(between(20, 50))))).await
    }

    /// Presses keys down in order, waits, and lets them go, last first, whatever happened.
    async fn press(&self, codes: &[KeyCode], hold: Option<Duration>) -> Res<()> {
        let mut pressed = Vec::with_capacity(codes.len());
        let result = async {
            for code in codes {
                self.step()?;
                self.computer.key(*code, true).await?;
                pressed.push(*code);
            }
            if let Some(d) = hold {
                sleep(d).await;
            }
            Ok::<_, Refusal>(())
        }
        .await;
        self.own_input();
        for code in pressed.iter().rev() {
            self.computer.key(*code, false).await?;
        }
        result
    }

    async fn stroke(&self, s: Stroke) -> Res<()> {
        let mut codes = Vec::with_capacity(3);
        if s.shift {
            codes.push(KeyCode::KEY_LEFTSHIFT);
        }
        if s.altgr {
            codes.push(KeyCode::KEY_RIGHTALT);
        }
        codes.push(s.code);
        self.press(&codes, None).await
    }

    /// The focused window, when niri can say it's blacked out from capture.
    async fn focused_hidden(&self, out: &Output) -> Res<bool> {
        let Some(windows) = self.computer.windows(out.name.clone()).await? else {
            return Ok(false);
        };
        let Some(w) = windows.into_iter().find(|w| w.focused && w.rect.is_some()) else {
            return Ok(false);
        };
        let frame = self.computer.capture(out.name.clone()).await?;
        Ok(hidden(&frame, out, &w))
    }

    async fn type_text(&self, out: &Output, text: &str) -> Res<()> {
        if self.focused_hidden(out).await? {
            return Err(Refusal::new(
                ErrorCode::Hidden,
                "The focused window is hidden from screenshots, so Hatbot won't type into it.",
            ));
        }
        let table = self.computer.key_table().await?;
        match typing::plan(text, &table) {
            TypePlan::Keys(strokes) if strokes.len() <= HUMAN_TYPING_CHARS => {
                for (i, s) in strokes.into_iter().enumerate() {
                    if i > 0 {
                        sleep(Duration::from_millis(key_gap())).await;
                    }
                    self.stroke(s).await?;
                }
            }
            TypePlan::Keys(strokes) => {
                for (i, chunk) in strokes.chunks(HUMAN_TYPING_CHARS).enumerate() {
                    if i > 0 {
                        sleep(Duration::from_millis(between(80, 200))).await;
                    }
                    for s in chunk {
                        self.stroke(*s).await?;
                        sleep(Duration::from_millis(8)).await;
                    }
                }
            }
            TypePlan::Paste => self.paste(text, &table).await?,
        }
        Ok(())
    }

    /// Text the layout can't type goes in through the clipboard, which gets back what it held.
    async fn paste(&self, text: &str, table: &KeyTable) -> Res<()> {
        let old = self.computer.clipboard().await?;
        let served = self.computer.set_clipboard(Some(Clip::text(text))).await?;
        let v = table.shortcut('v').map_or(KeyCode::KEY_V, |s| s.code);
        let pasted = self.press(&[KeyCode::KEY_LEFTCTRL, v], Some(Duration::from_millis(30))).await;
        // An app that doesn't paste on Ctrl+V (a terminal) never asks: the old clipboard comes back anyway.
        let _ = tokio::time::timeout(Duration::from_secs(1), served).await;
        self.computer.set_clipboard(old).await?;
        pasted
    }

    async fn move_to(
        &self,
        pointer: &mut Pointer,
        out: &Output,
        sc: &Scaling,
        to: (f64, f64),
    ) -> Res<()> {
        let (lx, ly) = sc.logical(to.0, to.1);
        // A curve can bow past the edge.
        let (lx, ly) =
            (lx.clamp(0.0, out.width as f64 - 1.0), ly.clamp(0.0, out.height as f64 - 1.0));
        self.step()?;
        self.computer.pointer_to(out.clone(), lx, ly).await?;
        pointer.at = Some((out.name.clone(), lx, ly));
        Ok(())
    }

    /// Moves the pointer along a person's curve, in the screenshot's pixels.
    async fn glide(
        &self,
        pointer: &mut Pointer,
        out: &Output,
        sc: &Scaling,
        to: (f64, f64),
    ) -> Res<()> {
        let from = match &pointer.at {
            Some((o, x, y)) if *o == out.name => Some(sc.shot(*x, *y)),
            _ => None,
        };
        let steps = match from {
            Some(f) => path(f, to),
            None => vec![to],
        };
        let last = steps.len().saturating_sub(1);
        for (i, p) in steps.into_iter().enumerate() {
            self.move_to(pointer, out, sc, p).await?;
            sleep(Duration::from_millis(if i == last { between(40, 120) } else { between(6, 16) }))
                .await;
        }
        Ok(())
    }

    async fn live_input(&self, input: LiveInput) -> Res<()> {
        let _pointer = self.input.lock().await;
        self.state().live_control_until = Some(Instant::now() + LIVE_CONTROL_HOLD);
        let (out, sc) = self.screen().await?;
        let at = |x: f64, y: f64| {
            let (x, y) = sc
                .logical(x.clamp(0.0, sc.width as f64 - 1.0), y.clamp(0.0, sc.height as f64 - 1.0));
            (out.clone(), x, y)
        };
        self.own_input();
        match input {
            LiveInput::Move { x, y } => {
                let (o, x, y) = at(x, y);
                self.computer.pointer_to(o, x, y).await?;
            }
            LiveInput::Button { button, down, x, y } => {
                let (o, x, y) = at(x, y);
                self.computer.pointer_to(o, x, y).await?;
                let b = match button {
                    2 => Button::Middle,
                    3 => Button::Right,
                    _ => Button::Left,
                };
                self.computer.button(b, down).await?;
            }
            LiveInput::Wheel { dy, dx, x, y } => {
                let (o, x, y) = at(x, y);
                self.computer.pointer_to(o, x, y).await?;
                let d = if dy != 0.0 { dy } else { dx };
                let steps = ((d.abs() / 50.0).round() as i32).clamp(1, 10) * d.signum() as i32;
                let (wx, wy) = if dy != 0.0 { (0, steps) } else { (steps, 0) };
                self.computer.wheel(wx, wy).await?;
            }
            LiveInput::Key { key, down } => match keys::browser_key(&key) {
                Some(code) => self.computer.key(code, down).await?,
                None if down => {
                    let table = self.computer.key_table().await?;
                    match key.chars().next().and_then(|c| table.stroke(c)) {
                        Some(s) => self.stroke(s).await?,
                        None => self.paste(&key, &table).await?,
                    }
                }
                None => {}
            },
            LiveInput::Unknown => {}
        }
        self.own_input();
        Ok(())
    }

    /// Frames per second for the live view now.
    pub fn live_fps(&self) -> u32 {
        match self.state().live_control_until {
            Some(t) if Instant::now() < t => LIVE_FPS_CONTROL,
            _ => LIVE_FPS_WATCHING,
        }
    }

    /// One live frame: a JPEG at the screenshots' size, so Live's pointer lands where it shows.
    pub async fn live_frame(&self) -> Res<Vec<u8>> {
        let (out, sc) = self.screen().await?;
        let frame = self.computer.capture(out.name).await?;
        Ok(jpeg(&resize(&frame, sc.width, sc.height), LIVE_QUALITY))
    }
}

fn owner() -> Refusal {
    Refusal::new(ErrorCode::Owner, "The owner is using the computer.")
}

fn screen(o: &Output) -> ComputerScreen {
    ComputerScreen { output: o.name.clone(), width: o.width, height: o.height, scale: o.scale }
}

/// Whether a window on the screen is blacked out in the frame.
fn hidden(frame: &Frame, out: &Output, w: &Window) -> bool {
    let Some(r) = w.rect else { return false };
    let fx = frame.width as f64 / out.width.max(1) as f64;
    let fy = frame.height as f64 / out.height.max(1) as f64;
    let x = (r.x.max(0.0) * fx) as u32;
    let y = (r.y.max(0.0) * fy) as u32;
    frame.black(x, y, (r.width * fx) as u32, (r.height * fy) as u32)
}

fn text(input: &Map<String, Value>) -> Res<String> {
    match input.get("text") {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err("text must be a string.".to_string().into()),
    }
}

/// A number from the input, clamped; `default` NaN means it's required.
fn num(input: &Map<String, Value>, name: &str, default: f64, min: f64, max: f64) -> Res<f64> {
    let v = match input.get(name) {
        None | Some(Value::Null) if !default.is_nan() => default,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if !v.is_finite() {
        return Err(format!("{name} must be a number.").into());
    }
    Ok(v.clamp(min, max))
}

fn point(sc: &Scaling, v: &Value) -> Res<(f64, f64)> {
    let xy =
        v.as_array().filter(|a| a.len() == 2).and_then(|a| Some((a[0].as_f64()?, a[1].as_f64()?)));
    let (x, y) = xy.ok_or_else(|| Refusal::from("coordinate must be [x, y].".to_string()))?;
    Ok(sc.point(x, y)?)
}

fn to_image(frame: &Frame) -> RgbImage {
    RgbImage::from_raw(frame.width, frame.height, frame.rgb.clone()).expect("a frame's size")
}

fn resize(frame: &Frame, width: u32, height: u32) -> RgbImage {
    let img = to_image(frame);
    if (img.width(), img.height()) == (width, height) {
        return img;
    }
    image::imageops::resize(&img, width, height, FilterType::Triangle)
}

fn jpeg(img: &RgbImage, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(img)
        .expect("encoding to memory");
    out
}

fn encode(img: &RgbImage, quality: u8) -> (String, u32, u32) {
    (STANDARD.encode(jpeg(img, quality)), img.width(), img.height())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::computer::Rect;
    use crate::fake::{Call, Fake};

    fn core(enabled: bool) -> (Arc<Fake>, Core) {
        let fake = Arc::new(Fake::new());
        let core = Core::new(fake.clone(), enabled);
        (fake, core)
    }

    fn action(name: ActionName, input: Value) -> Request {
        Request::Action { name, input: input.as_object().unwrap().clone() }
    }

    fn click(x: u32, y: u32) -> Request {
        action(ActionName::LeftClick, json!({"coordinate": [x, y]}))
    }

    async fn code(core: &Core, req: Request) -> Option<ErrorCode> {
        core.handle(req).await.err().map(|r| r.code)
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_all_but_status_while_switched_off() {
        let (fake, core) = core(false);
        assert_eq!(code(&core, Request::Screenshot).await, Some(ErrorCode::Disabled));
        assert_eq!(code(&core, click(10, 10)).await, Some(ErrorCode::Disabled));
        assert_eq!(
            code(&core, Request::Exec { command: "ls".into(), timeout_ms: 1000 }).await,
            Some(ErrorCode::Disabled)
        );
        assert_eq!(code(&core, Request::Status).await, None);
        assert!(fake.calls().is_empty());
        core.set_enabled(true);
        assert_eq!(code(&core, Request::Screenshot).await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_while_paused_or_locked() {
        let (_, core) = core(true);
        core.set_paused(true);
        assert_eq!(code(&core, click(10, 10)).await, Some(ErrorCode::Paused));
        core.set_paused(false);
        core.session_event(SessionEvent::Locked(true));
        assert_eq!(code(&core, Request::Screenshot).await, Some(ErrorCode::Locked));
        assert!(core.status().locked);
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_input_while_the_owner_is_using_it_but_not_after_its_own() {
        let (fake, core) = core(true);
        assert_eq!(code(&core, click(10, 10)).await, None);
        // The compositor's wake from Hatbot's own click isn't the owner.
        core.session_event(SessionEvent::Resumed);
        assert!(!core.status().owner_active);
        tokio::time::advance(Duration::from_secs(2)).await;
        core.session_event(SessionEvent::Resumed);
        assert!(core.status().owner_active);
        let before = fake.calls().len();
        assert_eq!(code(&core, click(10, 10)).await, Some(ErrorCode::Owner));
        assert_eq!(code(&core, Request::FocusWindow { id: 1 }).await, Some(ErrorCode::Owner));
        assert_eq!(fake.calls().len(), before);
        // Looking is fine.
        assert_eq!(code(&core, Request::Screenshot).await, None);
        core.session_event(SessionEvent::Quiet);
        assert_eq!(code(&core, click(10, 10)).await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn maps_the_screenshots_pixels_to_the_monitors() {
        let (fake, core) = core(true);
        let Ok(ComputerResult::Screenshot { width, height, .. }) =
            core.handle(Request::Screenshot).await
        else {
            panic!("no screenshot");
        };
        assert_eq!((width, height), (1280, 800));
        core.handle(click(640, 400)).await.unwrap();
        let calls = fake.calls();
        let last_move = calls.iter().rev().find_map(|c| match c {
            Call::Pointer(x, y) => Some((*x, *y)),
            _ => None,
        });
        assert_eq!(last_move, Some((800.0, 500.0)));
        assert!(
            calls.ends_with(&[Call::Button(Button::Left, true), Call::Button(Button::Left, false)])
        );
        assert_eq!(code(&core, click(1280, 10)).await, Some(ErrorCode::Failed));
        let Ok(ComputerResult::Action { result }) =
            core.handle(action(ActionName::CursorPosition, json!({}))).await
        else {
            panic!("no position");
        };
        assert_eq!((result.x, result.y), (Some(640), Some(400)));
    }

    #[tokio::test(start_paused = true)]
    async fn only_one_task_has_the_screen() {
        let (_, core) = core(true);
        core.handle(Request::Claim { task_id: "a".into() }).await.unwrap();
        assert_eq!(
            code(&core, Request::Claim { task_id: "b".into() }).await,
            Some(ErrorCode::Busy)
        );
        core.handle(Request::Release { task_id: "b".into() }).await.unwrap();
        assert!(core.status().screen.is_some());
        core.handle(Request::Release { task_id: "a".into() }).await.unwrap();
        assert_eq!(code(&core, Request::Claim { task_id: "b".into() }).await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn wont_type_into_a_window_blacked_out_from_capture() {
        let (fake, core) = core(true);
        let rect = Rect { x: 100.0, y: 100.0, width: 400.0, height: 300.0 };
        *fake.windows.lock().unwrap() = Some(vec![Window {
            id: 1,
            title: "Passwords".into(),
            app_id: "keepassxc".into(),
            focused: true,
            pid: Some(1),
            rect: Some(rect),
        }]);
        {
            let mut f = fake.frame.lock().unwrap();
            let w = f.width as usize;
            for y in 100..400 {
                for x in 100..500 {
                    f.rgb[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&[0, 0, 0]);
                }
            }
        }
        let typed = action(ActionName::Type, json!({"text": "secret"}));
        assert_eq!(code(&core, typed.clone()).await, Some(ErrorCode::Hidden));
        assert!(fake.calls().is_empty());
        let Ok(ComputerResult::Windows { windows }) = core.handle(Request::Windows).await else {
            panic!()
        };
        assert_eq!(windows[0].hidden, Some(true));
        // Shown again, it's typed into.
        fake.frame.lock().unwrap().rgb.fill(200);
        assert_eq!(code(&core, typed).await, None);
    }

    #[tokio::test(start_paused = true)]
    async fn pastes_what_the_layout_cant_type_and_puts_the_clipboard_back() {
        let (fake, core) = core(true);
        let old = Clip(vec![("image/png".into(), vec![1, 2, 3])]);
        *fake.clipboard.lock().unwrap() = Some(old.clone());
        core.handle(action(ActionName::Type, json!({"text": "ěa"}))).await.unwrap();
        let calls = fake.calls();
        assert_eq!(calls.first(), Some(&Call::SetClipboard(Some(Clip::text("ěa")))));
        assert!(calls.contains(&Call::Key(KeyCode::KEY_LEFTCTRL, true)));
        assert_eq!(calls.last(), Some(&Call::SetClipboard(Some(old))));
        // What the layout has is typed, no clipboard.
        fake.calls.lock().unwrap().clear();
        core.handle(action(ActionName::Type, json!({"text": "Aa"}))).await.unwrap();
        assert!(!fake.calls().iter().any(|c| matches!(c, Call::SetClipboard(_))));
    }

    #[tokio::test(start_paused = true)]
    async fn lets_go_of_modifiers_and_refuses_keys_off_the_lists() {
        let (fake, core) = core(true);
        core.handle(action(ActionName::Key, json!({"text": "ctrl+shift+Escape"}))).await.unwrap();
        let downs: Vec<_> =
            fake.calls().into_iter().filter(|c| matches!(c, Call::Key(_, true))).collect();
        let ups: Vec<_> =
            fake.calls().into_iter().filter(|c| matches!(c, Call::Key(_, false))).collect();
        assert_eq!(downs.len(), 3);
        assert_eq!(ups.len(), 3);
        assert_eq!(ups.last(), Some(&Call::Key(KeyCode::KEY_LEFTCTRL, false)));
        assert_eq!(
            code(&core, action(ActionName::Key, json!({"text": "0xff0d"}))).await,
            Some(ErrorCode::Failed)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_commands_that_run_as_root() {
        let (_, core) = core(true);
        let r =
            core.handle(Request::Exec { command: "sudo rm -rf /".into(), timeout_ms: 1000 }).await;
        assert_eq!(r.err().map(|r| r.code), Some(ErrorCode::Failed));
    }
}
