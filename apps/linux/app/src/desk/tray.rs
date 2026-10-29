// The tray icon: opens the window, pauses everything, and shows when Hatbot is using this computer.
use std::sync::OnceLock;

use ksni::menu::{MenuItem, StandardItem};
use ksni::{Icon, Status, ToolTip, TrayMethods};

use super::inbox::{self, Outside};

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

impl ksni::Tray for Tray {
    fn id(&self) -> String {
        "hatbot".into()
    }

    fn title(&self) -> String {
        "Hatbot".into()
    }

    fn activate(&mut self, _: i32, _: i32) {
        inbox::send(Outside::Open);
    }

    fn status(&self) -> Status {
        if self.needs_you > 0 || self.using_computer { Status::NeedsAttention } else { Status::Active }
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        hat_icons(self.using_computer, if self.needs_you > 0 || self.using_computer { LIME } else { PALE })
    }

    fn attention_icon_pixmap(&self) -> Vec<Icon> {
        self.icon_pixmap()
    }

    fn tool_tip(&self) -> ToolTip {
        let description = if self.using_computer {
            "Hatbot is using this computer.".to_string()
        } else if self.needs_you == 1 {
            "1 thing needs you.".to_string()
        } else if self.needs_you > 1 {
            format!("{} things need you.", self.needs_you)
        } else {
            String::new()
        };
        ToolTip { title: "Hatbot".into(), description, ..Default::default() }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let mut items: Vec<MenuItem<Self>> = vec![
            StandardItem {
                label: "Open Hatbot".into(),
                activate: Box::new(|_| inbox::send(Outside::Open)),
                ..Default::default()
            }
            .into(),
        ];
        if self.using_computer {
            items.push(
                StandardItem {
                    label: "Stop using this computer".into(),
                    activate: Box::new(|_| inbox::send(Outside::StopComputer)),
                    ..Default::default()
                }
                .into(),
            );
        }
        if self.signed_in {
            let paused = self.paused;
            items.push(
                StandardItem {
                    label: if paused { "Resume everything" } else { "Pause everything" }.into(),
                    activate: Box::new(move |_| inbox::send(Outside::Pause(!paused))),
                    ..Default::default()
                }
                .into(),
            );
        }
        items.push(MenuItem::Separator);
        items.push(
            StandardItem {
                label: "Quit".into(),
                activate: Box::new(|_| inbox::send(Outside::Quit)),
                ..Default::default()
            }
            .into(),
        );
        items
    }
}

static HANDLE: OnceLock<ksni::Handle<Tray>> = OnceLock::new();

/// Starts the tray; without a tray host (no StatusNotifierWatcher), the app runs on without one.
pub async fn start() {
    if HANDLE.get().is_some() {
        return;
    }
    if let Ok(h) = Tray::default().assume_sni_available(true).spawn().await {
        let _ = HANDLE.set(h);
    }
}

pub fn set(t: Tray) {
    let Some(h) = HANDLE.get() else { return };
    let h = h.clone();
    tokio::spawn(async move {
        h.update(move |x| {
            if *x != t {
                *x = t;
            }
        })
        .await;
    });
}

fn hat_icons(solid: bool, ink: [u8; 3]) -> Vec<Icon> {
    [22u32, 32, 48, 64].iter().filter_map(|&size| hat(size, solid, ink)).collect()
}

fn hat(size: u32, solid: bool, [r, g, b]: [u8; 3]) -> Option<Icon> {
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
    let mut data = Vec::with_capacity((size * size * 4) as usize);
    for p in pixmap.pixels() {
        let c = p.demultiply();
        data.extend_from_slice(&[c.alpha(), c.red(), c.green(), c.blue()]);
    }
    Some(Icon { width: size as i32, height: size as i32, data })
}
