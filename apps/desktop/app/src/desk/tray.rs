// The tray icon: opens the window, pauses everything, and shows when Hatbot is using this computer.
use std::sync::Mutex;

use crate::daemon::{self, Msg};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Tray {
    pub signed_in: bool,
    pub needs_you: usize,
    pub paused: bool,
    /// A task is using this computer's screen.
    pub using_computer: bool,
}

const LIME: [u8; 3] = [0xbb, 0xe4, 0x81];
const PALE: [u8; 3] = [0xe4, 0xe7, 0xd7];

impl Tray {
    fn attention(&self) -> bool {
        self.needs_you > 0 || self.using_computer
    }

    fn tip(&self) -> String {
        if self.using_computer {
            "Hatbot is using this computer.".into()
        } else if self.needs_you == 1 {
            "1 thing needs you.".into()
        } else if self.needs_you > 1 {
            format!("{} things need you.", self.needs_you)
        } else {
            String::new()
        }
    }

    /// (id, label) of each item; "" is a separator.
    fn items(&self) -> Vec<(&'static str, &'static str)> {
        let mut items = vec![("open", "Open Hatbot")];
        if self.using_computer {
            items.push(("stop", "Stop using this computer"));
        }
        if self.signed_in {
            items.push(("computer", "This computer"));
            items.push(if self.paused { ("resume", "Resume everything") } else { ("pause", "Pause everything") });
        }
        items.push(("", ""));
        items.push(("quit", "Quit"));
        items
    }

    fn icons(&self) -> Vec<(u32, Vec<u8>)> {
        let ink = if self.attention() { LIME } else { PALE };
        [22u32, 32, 48, 64].iter().filter_map(|&size| Some((size, hat(size, self.using_computer, ink)?))).collect()
    }
}

fn chosen(id: &str) {
    daemon::send(match id {
        "open" => Msg::Open(None),
        "stop" => Msg::StopComputer,
        "computer" => Msg::FromPage("computer".into()),
        "pause" => Msg::Pause(true),
        "resume" => Msg::Pause(false),
        "quit" => Msg::Quit,
        _ => return,
    });
}

/// The hat, as RGBA rows.
fn hat(size: u32, solid: bool, [r, g, b]: [u8; 3]) -> Option<Vec<u8>> {
    let color = format!("#{r:02x}{g:02x}{b:02x}");
    let crown = if solid {
        format!(r#"<path fill="{color}" d="M7 15.5V7c0-1.7 2.2-3 5-3s5 1.3 5 3v8.5z"/>"#)
    } else {
        r#"<path d="M7 15.5V7c0-1.7 2.2-3 5-3s5 1.3 5 3v8.5"/><path d="M7 12.5c1.4.6 3.1 1 5 1s3.6-.4 5-1"/>"#.into()
    };
    let doc = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="{color}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">{crown}<path d="M2.5 16c1.4 2.1 5.2 3.5 9.5 3.5s8.1-1.4 9.5-3.5"/></g></svg>"#
    );
    let tree = resvg::usvg::Tree::from_str(&doc, &Default::default()).ok()?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size)?;
    let scale = size as f32 / 24.0;
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    Some(
        pixmap
            .pixels()
            .iter()
            .map(|p| p.demultiply())
            .flat_map(|c| [c.red(), c.green(), c.blue(), c.alpha()])
            .collect(),
    )
}

static LAST: Mutex<Option<Tray>> = Mutex::new(None);

pub fn set(t: Tray) {
    let mut last = LAST.lock().unwrap();
    if last.as_ref() != Some(&t) {
        *last = Some(t.clone());
        imp::set(t);
    }
}

pub use imp::start;

#[cfg(target_os = "linux")]
mod imp {
    use std::sync::OnceLock;

    use ksni::menu::{MenuItem, StandardItem};
    use ksni::{Icon, Status, ToolTip, TrayMethods};
    use tauri::AppHandle;

    use super::Tray;

    struct Sni(Tray);

    impl ksni::Tray for Sni {
        fn id(&self) -> String {
            "hatbot".into()
        }

        fn title(&self) -> String {
            "Hatbot".into()
        }

        fn activate(&mut self, _: i32, _: i32) {
            super::chosen("open");
        }

        fn status(&self) -> Status {
            if self.0.attention() { Status::NeedsAttention } else { Status::Active }
        }

        fn icon_pixmap(&self) -> Vec<Icon> {
            self.0
                .icons()
                .into_iter()
                .map(|(size, rgba)| Icon {
                    width: size as i32,
                    height: size as i32,
                    // StatusNotifierItem wants ARGB.
                    data: rgba.chunks(4).flat_map(|p| [p[3], p[0], p[1], p[2]]).collect(),
                })
                .collect()
        }

        fn attention_icon_pixmap(&self) -> Vec<Icon> {
            self.icon_pixmap()
        }

        fn tool_tip(&self) -> ToolTip {
            ToolTip { title: "Hatbot".into(), description: self.0.tip(), ..Default::default() }
        }

        fn menu(&self) -> Vec<MenuItem<Self>> {
            self.0
                .items()
                .into_iter()
                .map(|(id, label)| {
                    if id.is_empty() {
                        MenuItem::Separator
                    } else {
                        StandardItem {
                            label: label.into(),
                            activate: Box::new(move |_| super::chosen(id)),
                            ..Default::default()
                        }
                        .into()
                    }
                })
                .collect()
        }
    }

    static HANDLE: OnceLock<ksni::Handle<Sni>> = OnceLock::new();

    /// Starts the tray; without a tray host (no StatusNotifierWatcher), the app runs on without one.
    pub async fn start(_: &AppHandle) {
        if HANDLE.get().is_some() {
            return;
        }
        if let Ok(h) = Sni(Tray::default()).assume_sni_available(true).spawn().await {
            let _ = HANDLE.set(h);
        }
    }

    pub fn set(t: Tray) {
        let Some(h) = HANDLE.get() else { return };
        let h = h.clone();
        tauri::async_runtime::spawn(async move {
            h.update(move |x| x.0 = t).await;
        });
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use tauri::image::Image;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
    use tauri::{AppHandle, Wry};

    use super::Tray;

    static ICON: OnceLock<(AppHandle, TrayIcon)> = OnceLock::new();

    fn menu(app: &AppHandle, t: &Tray) -> tauri::Result<Menu<Wry>> {
        let menu = Menu::new(app)?;
        for (id, label) in t.items() {
            if id.is_empty() {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            } else {
                menu.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
            }
        }
        Ok(menu)
    }

    fn icon(t: &Tray) -> Option<Image<'static>> {
        let (size, rgba) = t.icons().into_iter().find(|(s, _)| *s == 32)?;
        Some(Image::new_owned(rgba, size, size))
    }

    pub async fn start(app: &AppHandle) {
        let t = Tray::default();
        let mut b = TrayIconBuilder::with_id("hatbot")
            .tooltip("Hatbot")
            .show_menu_on_left_click(false)
            .on_menu_event(|_, e| super::chosen(e.id().as_ref()))
            .on_tray_icon_event(|_, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    super::chosen("open");
                }
            });
        if let Ok(m) = menu(app, &t) {
            b = b.menu(&m);
        }
        if let Some(i) = icon(&t) {
            b = b.icon(i);
        }
        if let Ok(tray) = b.build(app) {
            let _ = ICON.set((app.clone(), tray));
        }
    }

    pub fn set(t: Tray) {
        let Some((app, tray)) = ICON.get() else { return };
        let tip = t.tip();
        let _ = tray.set_tooltip(Some(if tip.is_empty() { "Hatbot".to_string() } else { format!("Hatbot: {tip}") }));
        let _ = tray.set_icon(icon(&t));
        if let Ok(m) = menu(app, &t) {
            let _ = tray.set_menu(Some(m));
        }
    }
}
