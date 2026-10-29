//! The real computer: a wlroots-style Wayland session (niri's IPC on top when it's niri), a uinput
//! keyboard, AT-SPI and logind.

mod atspi;
mod logind;
mod niri;
mod uinput;
pub mod wayland;
#[cfg(test)]
mod wayland_tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use evdev::KeyCode;
use tokio::sync::{mpsc, oneshot};

use crate::computer::{
    BoxFuture, Button, Clip, Computer, Frame, InspectAt, Output, Result, SessionEvent, Window,
};
use crate::protocol::AgentElement;
use crate::typing::KeyTable;

use self::atspi::Atspi;
use self::niri::Niri;
use self::uinput::Keyboard;
use self::wayland::Wayland;

pub struct LinuxComputer {
    events: mpsc::UnboundedSender<SessionEvent>,
    wayland: Mutex<Option<Arc<Wayland>>>,
    keyboard: Mutex<Option<Keyboard>>,
    niri: Option<Niri>,
    atspi: tokio::sync::Mutex<Option<Arc<Atspi>>>,
    has_atspi: Arc<AtomicBool>,
    keymap: Mutex<Option<(String, KeyTable)>>,
    compositor: String,
}

fn compositor() -> String {
    let env = |k: &str| std::env::var_os(k).is_some();
    if env("NIRI_SOCKET") {
        "niri".into()
    } else if env("SWAYSOCK") {
        "sway".into()
    } else if env("HYPRLAND_INSTANCE_SIGNATURE") {
        "hyprland".into()
    } else {
        std::env::var("XDG_CURRENT_DESKTOP")
            .ok()
            .and_then(|d| d.split(':').next().map(str::to_lowercase))
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "wayland".into())
    }
}

impl LinuxComputer {
    /// Connects to the session. Inside a Tokio runtime: the lock and accessibility watchers run on it.
    pub fn start() -> (Self, mpsc::UnboundedReceiver<SessionEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        let wayland = Wayland::connect(None, events.clone())
            .inspect_err(|e| tracing::warn!("{e}"))
            .ok()
            .map(Arc::new);
        // Made now so the compositor has picked the device up before the first key.
        let keyboard = Keyboard::open().inspect_err(|e| tracing::warn!("{e}")).ok();
        tokio::spawn(logind::watch(events.clone()));
        let me = Self {
            events,
            wayland: Mutex::new(wayland),
            keyboard: Mutex::new(keyboard),
            niri: Niri::from_env(),
            atspi: Default::default(),
            has_atspi: Default::default(),
            keymap: Mutex::new(None),
            compositor: compositor(),
        };
        let has = me.has_atspi.clone();
        tokio::spawn(async move {
            has.store(Atspi::connect().await.is_ok(), Ordering::Relaxed);
        });
        (me, rx)
    }

    /// The Wayland connection, made again if the compositor restarted.
    fn wayland(&self) -> Result<Arc<Wayland>> {
        let mut w = self.wayland.lock().expect("wayland lock");
        if let Some(cur) = w.as_ref().filter(|c| c.alive()) {
            return Ok(cur.clone());
        }
        let fresh = Arc::new(Wayland::connect(None, self.events.clone())?);
        *w = Some(fresh.clone());
        Ok(fresh)
    }

    async fn atspi(&self) -> Result<Arc<Atspi>> {
        let mut a = self.atspi.lock().await;
        if let Some(a) = a.as_ref() {
            return Ok(a.clone());
        }
        let fresh = Arc::new(Atspi::connect().await?);
        self.has_atspi.store(true, Ordering::Relaxed);
        *a = Some(fresh.clone());
        Ok(fresh)
    }
}

impl Computer for LinuxComputer {
    fn compositor(&self) -> String {
        self.compositor.clone()
    }

    fn features(&self) -> Vec<String> {
        let has = self.wayland().map(|w| w.has).unwrap_or_default();
        let keyboard = self.keyboard.lock().expect("keyboard lock").is_some();
        let mut f = vec![];
        if has.screencopy {
            f.extend(["screen", "live"]);
        }
        if has.pointer && keyboard {
            f.push("input");
        }
        if self.niri.is_some() {
            f.push("windows");
        }
        if self.has_atspi.load(Ordering::Relaxed) {
            f.push("atspi");
        }
        f.extend(["files", "shell"]);
        f.into_iter().map(String::from).collect()
    }

    fn focused_output(&self) -> BoxFuture<'_, Result<Output>> {
        Box::pin(async move {
            if let Some(niri) = &self.niri
                && let Some(o) = niri.focused_output().await?
                && let Some(l) = o.logical
            {
                return Ok(Output {
                    name: o.name,
                    width: l.width,
                    height: l.height,
                    scale: l.scale,
                });
            }
            // Elsewhere the first monitor stands in: wlroots doesn't say which has focus.
            let outputs = self.wayland()?.outputs().await?;
            let o = outputs.into_iter().next().ok_or("There's no monitor.")?;
            Ok(Output { name: o.name, width: o.width, height: o.height, scale: o.scale })
        })
    }

    fn capture(&self, output: String) -> BoxFuture<'_, Result<Frame>> {
        Box::pin(async move { self.wayland()?.capture(output).await })
    }

    fn pointer_to(&self, output: Output, x: f64, y: f64) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.wayland()?.motion(output.name, x, y).await })
    }

    fn button(&self, button: Button, down: bool) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.wayland()?.button(button, down).await })
    }

    fn wheel(&self, dx: i32, dy: i32) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.wayland()?.wheel(dx, dy).await })
    }

    fn key(&self, code: KeyCode, down: bool) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let mut k = self.keyboard.lock().expect("keyboard lock");
            if k.is_none() {
                *k = Some(Keyboard::open()?);
            }
            k.as_mut().expect("opened").key(code, down)
        })
    }

    fn key_table(&self) -> BoxFuture<'_, Result<KeyTable>> {
        Box::pin(async move {
            let text = self.wayland()?.keymap().await?.unwrap_or_default();
            let current = match &self.niri {
                Some(n) => n.layout().await.unwrap_or(0),
                None => 0,
            };
            let mut cache = self.keymap.lock().expect("keymap lock");
            let table = match cache.as_ref() {
                Some((t, table)) if *t == text => table.clone(),
                _ => {
                    let table = if text.is_empty() {
                        KeyTable::default_keymap()
                    } else {
                        KeyTable::from_keymap(&text)
                    }
                    .ok_or("Can't read this computer's keyboard layout.")?;
                    *cache = Some((text, table.clone()));
                    table
                }
            };
            let mut table = table;
            table.current = current;
            Ok(table)
        })
    }

    fn clipboard(&self) -> BoxFuture<'_, Result<Option<Clip>>> {
        Box::pin(async move { self.wayland()?.clipboard().await })
    }

    fn set_clipboard(&self, clip: Option<Clip>) -> BoxFuture<'_, Result<oneshot::Receiver<()>>> {
        Box::pin(async move { self.wayland()?.set_clipboard(clip).await })
    }

    fn windows(&self, output: String) -> BoxFuture<'_, Result<Option<Vec<Window>>>> {
        Box::pin(async move {
            match &self.niri {
                Some(n) => n.windows(&output).await.map(Some),
                None => Ok(None),
            }
        })
    }

    fn focus_window(&self, id: u64) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            match &self.niri {
                Some(n) => n.focus_window(id).await,
                None => Err("This computer's compositor can't focus windows for Hatbot.".into()),
            }
        })
    }

    fn inspect(&self, at: InspectAt) -> BoxFuture<'_, Result<Option<AgentElement>>> {
        Box::pin(async move {
            match self.atspi().await {
                Ok(a) => a.inspect(at).await,
                // No accessibility bus: no tree.
                Err(_) => Ok(None),
            }
        })
    }
}
