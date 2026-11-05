//! The windows on the desktop, front to back, as the taskbar would show them.

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetWindowDisplayAffinity, GetWindowLongW,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_RESTORE,
    SetForegroundWindow, ShowWindow, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PWSTR};

use super::screen::Monitor;
use crate::computer::{Rect, Result, Window};

fn hwnd(id: u64) -> HWND {
    HWND(id as usize as *mut _)
}

fn title(h: HWND) -> String {
    // SAFETY: the buffer is as long as the length asked for.
    unsafe {
        let len = GetWindowTextLengthW(h);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(h, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

/// The program's file name without ".exe", as Hatbot names the app.
fn app(pid: u32) -> String {
    // SAFETY: the handle is closed before returning, and the buffer's length goes with it.
    unsafe {
        let Ok(p) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(p);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit('\\').next().unwrap_or(&path);
        file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file).to_string()
    }
}

/// Shown on the desktop: visible, titled, not hidden away by DWM (another virtual desktop, a
/// suspended store app) and not a tool palette.
fn listed(h: HWND) -> bool {
    // SAFETY: plain reads of a window's attributes, into a stack value of the size given.
    unsafe {
        if !IsWindowVisible(h).as_bool() || GetWindowTextLengthW(h) == 0 {
            return false;
        }
        if GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        let mut cloaked = 0u32;
        let got = DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), size_of::<u32>() as u32);
        !(got.is_ok() && cloaked != 0)
    }
}

/// Where a window is on a monitor, in its logical pixels: its frame as drawn, without the invisible
/// borders Windows puts round it for resizing.
fn placed(h: HWND, m: &Monitor) -> Option<Rect> {
    // SAFETY: plain reads into stack values of the size given.
    let r = unsafe {
        if IsIconic(h).as_bool() {
            return None;
        }
        let mut r = RECT::default();
        DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, (&mut r as *mut RECT).cast(), size_of::<RECT>() as u32)
            .ok()?;
        r
    };
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let on = (m.rect.left..m.rect.right).contains(&cx) && (m.rect.top..m.rect.bottom).contains(&cy);
    on.then(|| Rect {
        x: (r.left - m.rect.left) as f64 / m.scale,
        y: (r.top - m.rect.top) as f64 / m.scale,
        width: (r.right - r.left) as f64 / m.scale,
        height: (r.bottom - r.top) as f64 / m.scale,
    })
}

pub fn list(m: &Monitor) -> Vec<Window> {
    unsafe extern "system" fn each(h: HWND, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the Vec below, alive for the whole enumeration.
        unsafe { &mut *(data.0 as *mut Vec<HWND>) }.push(h);
        true.into()
    }
    let mut all: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes onto `all`.
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut all as *mut _ as isize)) };
    // SAFETY: no pointers.
    let front = unsafe { GetForegroundWindow() };
    all.into_iter()
        .filter(|h| listed(*h))
        .map(|h| {
            let mut pid = 0u32;
            let mut affinity = 0u32;
            // SAFETY: plain out-parameters.
            unsafe {
                GetWindowThreadProcessId(h, Some(&mut pid));
                let _ = GetWindowDisplayAffinity(h, &mut affinity);
            }
            Window {
                id: h.0 as usize as u64,
                title: title(h),
                app_id: app(pid),
                focused: h == front,
                pid: (pid != 0).then_some(pid as i32),
                rect: placed(h, m),
                excluded: affinity != 0,
            }
        })
        .collect()
}

/// Brings a window to the front. Windows lets only the thread with the foreground take it, so this
/// joins that thread's input for a moment; it runs on the agent's own window thread.
pub fn focus(id: u64) -> Result<()> {
    let h = hwnd(id);
    // SAFETY: plain calls on a window handle; a stale one only fails them.
    unsafe {
        if !IsWindowVisible(h).as_bool() {
            return Err("That window is gone.".into());
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let me = GetCurrentThreadId();
        let theirs = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let joined = theirs != 0 && theirs != me && AttachThreadInput(me, theirs, true).as_bool();
        let _ = BringWindowToTop(h);
        let _ = SetForegroundWindow(h);
        if joined {
            let _ = AttachThreadInput(me, theirs, false);
        }
        if GetForegroundWindow() != h {
            return Err("Windows didn't bring that window to the front.".into());
        }
    }
    Ok(())
}
