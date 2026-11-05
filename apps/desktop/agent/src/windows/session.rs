//! A thread with a hidden window of the agent's: Windows tells it when the session locks, apps ask it
//! for what it put on the clipboard, and what has to run on a window's thread runs there. Another
//! thread watches for the owner's input, the way Wayland's idle notifications do.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK, WTSFreeMemory, WTSINFOEXW,
    WTSQuerySessionInformationW, WTSRegisterSessionNotification, WTSSessionInfoEx,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, PostMessageW, RegisterClassW, WINDOW_EX_STYLE,
    WM_APP, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED,
};
use windows::core::{PWSTR, w};

use super::clipboard;
use crate::activity::{NOTICE_MS, QUIET_MS};
use crate::computer::{Result, SessionEvent};

const WTS_SESSION_LOCK: usize = 7;
const WTS_SESSION_UNLOCK: usize = 8;

static WINDOW: OnceLock<usize> = OnceLock::new();
static EVENTS: OnceLock<mpsc::UnboundedSender<SessionEvent>> = OnceLock::new();

type Job = Box<dyn FnOnce(HWND) + Send>;

pub fn start(events: mpsc::UnboundedSender<SessionEvent>) {
    let _ = EVENTS.set(events.clone());
    let _ = std::thread::Builder::new().name("hatbot-window".into()).spawn(window_thread);
    let _ = std::thread::Builder::new().name("hatbot-idle".into()).spawn(move || watch_input(events));
}

fn send(ev: SessionEvent) {
    if let Some(e) = EVENTS.get() {
        let _ = e.send(ev);
    }
}

fn locked_now() -> Option<bool> {
    let mut buf = PWSTR::null();
    let mut len = 0u32;
    // SAFETY: Windows allocates the buffer, read as the WTSINFOEXW asked for and freed after.
    unsafe {
        WTSQuerySessionInformationW(None, WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buf, &mut len).ok()?;
        let info = &*(buf.0 as *const WTSINFOEXW);
        let flags = if info.Level == 1 { Some(info.Data.WTSInfoExLevel1.SessionFlags) } else { None };
        WTSFreeMemory(buf.0.cast());
        flags.map(|f| f as u32 == WTS_SESSIONSTATE_LOCK)
    }
}

fn window_thread() {
    // SAFETY: the class and window live as long as the thread, which runs their message loop.
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: module.into(),
            lpszClassName: w!("HatbotAgent"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let Ok(h) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("HatbotAgent"),
            w!("Hatbot"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(module.into()),
            None,
        ) else {
            tracing::warn!("The agent's window didn't open.");
            return;
        };
        let _ = WINDOW.set(h.0 as usize);
        if WTSRegisterSessionNotification(h, NOTIFY_FOR_THIS_SESSION).is_err() {
            tracing::warn!("Windows won't say when the session locks.");
        }
        if let Some(on) = locked_now() {
            send(SessionEvent::Locked(on));
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_APP => {
            // SAFETY: `run` posted this pointer from Box::into_raw, once.
            let job = unsafe { Box::from_raw(lp.0 as *mut Job) };
            job(h);
            LRESULT(0)
        }
        WM_WTSSESSION_CHANGE => {
            match wp.0 {
                WTS_SESSION_LOCK => send(SessionEvent::Locked(true)),
                WTS_SESSION_UNLOCK => send(SessionEvent::Locked(false)),
                _ => {}
            }
            LRESULT(0)
        }
        // SAFETY: the window's own messages, handed on as they came.
        _ => clipboard::message(h, msg, wp).unwrap_or_else(|| unsafe { DefWindowProcW(h, msg, wp, lp) }),
    }
}

/// Runs `f` on the window's thread with its window.
pub async fn run<T: Send + 'static>(f: impl FnOnce(HWND) -> T + Send + 'static) -> Result<T> {
    let gone = || "Hatbot's agent lost its window.".to_string();
    let &h = WINDOW.get().ok_or_else(gone)?;
    let (tx, rx) = oneshot::channel();
    let job: Job = Box::new(move |h| drop(tx.send(f(h))));
    let ptr = Box::into_raw(Box::new(job));
    // SAFETY: on success the window's thread takes the pointer back; on failure it's taken back here.
    if unsafe { PostMessageW(Some(HWND(h as *mut _)), WM_APP, WPARAM(0), LPARAM(ptr as isize)) }.is_err() {
        drop(unsafe { Box::from_raw(ptr) });
        return Err(gone());
    }
    rx.await.map_err(|_| gone())
}

/// Hatbot's own input counts here too, as it does on Wayland; the core leaves that out.
fn watch_input(events: mpsc::UnboundedSender<SessionEvent>) {
    let last = || {
        let mut i = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: a plain out-parameter.
        unsafe { GetLastInputInfo(&mut i) }.as_bool().then_some(i.dwTime)
    };
    let Some(mut seen) = last() else { return };
    let mut quiet = false;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let Some(at) = last() else { continue };
        // SAFETY: no pointers.
        let now = unsafe { GetTickCount() };
        if at != seen {
            if at.wrapping_sub(seen) >= NOTICE_MS || quiet {
                let _ = events.send(SessionEvent::Resumed);
            }
            seen = at;
            quiet = false;
        } else if !quiet && now.wrapping_sub(at) >= QUIET_MS {
            quiet = true;
            if events.send(SessionEvent::Quiet).is_err() {
                return;
            }
        }
    }
}
