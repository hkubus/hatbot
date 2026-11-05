// The window: the app's own pages until it's signed in, then the brain's web app. Nothing but those
// two loads in it; links elsewhere open in the browser, and the web app's `hatbot-app://` links
// reach the daemon instead of going anywhere.
use std::path::PathBuf;
use std::sync::RwLock;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::daemon::{self, Msg};
use crate::desk::{notices, open};

pub const MAIN: &str = "main";
const COMPUTER: &str = "computer";

/// The brain the window may show, while signed in.
static BRAIN: RwLock<Option<Url>> = RwLock::new(None);

pub fn set_brain(server: Option<&str>) {
    *BRAIN.write().unwrap() = server.and_then(|s| Url::parse(s).ok());
}

fn local_url(app: &AppHandle) -> Url {
    #[cfg(dev)]
    if let Some(url) = &app.config().build.dev_url {
        return url.clone();
    }
    let _ = app;
    Url::parse(if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" }).expect("a URL")
}

fn same_site(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn on_brain(url: &Url) -> bool {
    BRAIN.read().unwrap().as_ref().is_some_and(|b| same_site(b, url))
}

const USER_AGENT: &str =
    concat!("Mozilla/5.0 (compatible) AppleWebKit/605.1.15 (KHTML, like Gecko) HatbotApp/", env!("CARGO_PKG_VERSION"));

fn builder<'a>(app: &'a AppHandle, label: &'a str, url: WebviewUrl) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let local = local_url(app);
    let init = format!("window.hatbotApp = {{ platform: {:?} }};", crate::core::OS.to_lowercase());
    WebviewWindowBuilder::new(app, label, url)
        .title("Hatbot")
        .user_agent(&format!("{USER_AGENT} ({})", crate::core::OS))
        .initialization_script(init)
        .on_navigation(move |url| {
            if url.scheme() == "hatbot-app" {
                daemon::send(Msg::FromPage(url.host_str().unwrap_or_default().to_string()));
                return false;
            }
            if same_site(url, &local) || on_brain(url) || url.scheme() == "about" {
                return true;
            }
            open::external(url.as_str());
            false
        })
        .on_new_window(|url, _| {
            open::external(url.as_str());
            NewWindowResponse::Deny
        })
        .on_download(|_, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .or_else(|| url.path_segments()?.next_back().map(str::to_string))
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| "download".into());
                    *destination = free_path(&downloads(), &name);
                }
                DownloadEvent::Finished { path: Some(path), success: true, .. } => {
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    notices::tell(&format!("Saved {name} in Downloads."));
                }
                DownloadEvent::Finished { .. } => notices::tell("The download didn't finish."),
                _ => {}
            }
            true
        })
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn build_main(app: &AppHandle, url: WebviewUrl) {
    let built = builder(app, MAIN, url).inner_size(1280.0, 820.0).min_inner_size(720.0, 480.0).build();
    if let Err(e) = built {
        notices::tell(&format!("The window didn't open: {e}"));
    }
}

pub fn is_open(app: &AppHandle) -> bool {
    main_window(app).is_some()
}

pub fn is_focused(app: &AppHandle) -> bool {
    main_window(app).and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

/// The app's own pages: the welcome, signing in, setting up.
pub fn open_local(app: &AppHandle) {
    match main_window(app) {
        Some(w) => focus(&w),
        None => build_main(app, WebviewUrl::App("index.html".into())),
    }
}

/// Back to the app's own pages after signing out, if the window is open.
pub fn reopen_local(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.navigate(local_url(app).join("index.html").expect("a URL"));
    }
}

/// Loads a page of the brain's (a sign-in link, say) in the window, opening it if it's closed.
pub fn load(app: &AppHandle, url: &str) {
    let Ok(url) = Url::parse(url) else { return };
    match main_window(app) {
        Some(w) => {
            let _ = w.navigate(url);
            focus(&w);
        }
        None => build_main(app, WebviewUrl::External(url)),
    }
}

/// Opens a page of the web app: in the web app already shown, without loading it again.
pub fn go(app: &AppHandle, server: &str, path: &str) {
    if let Some(w) = main_window(app)
        && w.url().is_ok_and(|u| on_brain(&u))
    {
        let _ = w.eval(format!("window.hatbotApp?.go?.({path:?})"));
        focus(&w);
        return;
    }
    load(app, &format!("{server}{path}"));
}

/// The web app's page the window is on, to sign it in again there.
pub fn web_page(app: &AppHandle) -> Option<String> {
    let url = main_window(app)?.url().ok().filter(on_brain)?;
    Some(match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    })
}

pub fn open_computer(app: &AppHandle) {
    match app.get_webview_window(COMPUTER) {
        Some(w) => focus(&w),
        None => {
            let built = builder(app, COMPUTER, WebviewUrl::App("index.html".into()))
                .title("This computer")
                .inner_size(560.0, 640.0)
                .min_inner_size(420.0, 400.0)
                .build();
            if let Err(e) = built {
                notices::tell(&format!("The window didn't open: {e}"));
            }
        }
    }
}

fn focus(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn downloads() -> PathBuf {
    let home = PathBuf::from(std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default());
    #[cfg(target_os = "linux")]
    if let Ok(dirs) = std::fs::read_to_string(home.join(".config/user-dirs.dirs"))
        && let Some(dir) = dirs.lines().find_map(|l| l.strip_prefix("XDG_DOWNLOAD_DIR="))
    {
        return PathBuf::from(dir.trim_matches('"').replace("$HOME", &home.to_string_lossy()));
    }
    home.join("Downloads")
}

/// `name` in `dir`, or "name (2)" and so on beside a file already there.
fn free_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let name = name.replace(['/', '\\'], "_");
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    (1..)
        .map(|n| dir.join(if n == 1 { name.clone() } else { format!("{stem} ({n}){ext}") }))
        .find(|p| !p.exists())
        .expect("a free name")
}
