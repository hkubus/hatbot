//! The Wayland side against a real wlroots compositor: a headless sway. Slow and needs sway, so only
//! with HATBOT_WAYLAND_TESTS=1.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use super::wayland::Wayland;
use crate::computer::{Button, Clip};

struct Sway {
    child: Child,
    dir: PathBuf,
}

impl Drop for Sway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A headless sway with one 1600x1000 monitor at scale 2, and its socket.
fn sway(name: &str) -> Option<(Sway, PathBuf)> {
    std::env::var_os("HATBOT_WAYLAND_TESTS")?;
    let dir = std::env::temp_dir().join(format!("hatbot-sway-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let config = dir.join("config");
    std::fs::write(&config, "xwayland disable\noutput * mode 1600x1000 scale 2\n").unwrap();
    let child = Command::new("sway")
        .args(["-c".as_ref(), config.as_os_str()])
        .env("XDG_RUNTIME_DIR", &dir)
        .env("WLR_BACKENDS", "headless")
        .env("WLR_LIBINPUT_NO_DEVICES", "1")
        .env("WLR_RENDERER", "pixman")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("SWAYSOCK")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("sway (apt or pacman install sway)");
    let sway = Sway { child, dir: dir.clone() };
    let deadline = Instant::now() + Duration::from_secs(10);
    let socket = loop {
        let found = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("wayland-") && !n.to_string_lossy().ends_with(".lock"))
        });
        if let Some(s) = found {
            break s;
        }
        assert!(Instant::now() < deadline, "sway didn't start");
        std::thread::yield_now();
    };
    Some((sway, socket))
}

fn connect(socket: &Path) -> Wayland {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match Wayland::connect(Some(socket), mpsc::unbounded_channel().0) {
            Ok(w) => return w,
            Err(e) => assert!(Instant::now() < deadline, "{e}"),
        }
    }
}

#[tokio::test]
async fn captures_the_monitor_and_moves_the_pointer_on_it() {
    let Some((_sway, socket)) = sway("capture") else { return };
    let w = connect(&socket);
    assert!(w.has.screencopy && w.has.pointer);
    let outputs = w.outputs().await.unwrap();
    let out = &outputs[0];
    assert_eq!((out.width, out.height, out.scale), (800, 500, 2.0));
    let first = w.capture(out.name.clone()).await.unwrap();
    assert_eq!((first.width, first.height), (1600, 1000));

    // The pointer drawn into the capture shows where it went.
    w.motion(out.name.clone(), 100.0, 100.0).await.unwrap();
    w.button(Button::Left, true).await.unwrap();
    w.button(Button::Left, false).await.unwrap();
    w.wheel(0, 1).await.unwrap();
    let at_100 = w.capture(out.name.clone()).await.unwrap();
    w.motion(out.name.clone(), 600.0, 400.0).await.unwrap();
    let at_600 = w.capture(out.name.clone()).await.unwrap();
    let region = |f: &crate::computer::Frame, x: u32, y: u32| -> Vec<u8> {
        (y..y + 40)
            .flat_map(|py| {
                let i = ((py * f.width + x) * 3) as usize;
                f.rgb[i..i + 120].to_vec()
            })
            .collect()
    };
    assert_ne!(region(&at_100, 200, 200), region(&at_600, 200, 200), "no pointer at (100, 100)");
    assert_ne!(region(&at_100, 1200, 800), region(&at_600, 1200, 800), "no pointer at (600, 400)");
    let again = w.capture(out.name.clone()).await.unwrap();
    assert_eq!(region(&again, 200, 200), region(&at_600, 200, 200));
}

#[tokio::test]
async fn sets_and_reads_the_clipboard() {
    let Some((_sway, socket)) = sway("clipboard") else { return };
    let w = connect(&socket);
    w.set_clipboard(Some(Clip::text("hello ě"))).await.unwrap();
    // The selection comes back through the compositor as an offer of its own.
    let deadline = Instant::now() + Duration::from_secs(5);
    let clip = loop {
        if let Some(c) = w.clipboard().await.unwrap() {
            break c;
        }
        assert!(Instant::now() < deadline, "the clipboard stayed empty");
        tokio::task::yield_now().await;
    };
    let text = clip.0.iter().find(|(m, _)| m == "text/plain;charset=utf-8").map(|(_, b)| b.clone());
    assert_eq!(text.as_deref(), Some("hello ě".as_bytes()));
}
