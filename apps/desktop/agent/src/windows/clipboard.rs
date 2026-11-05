//! The clipboard. What it held is read whole, each format as its bytes ("windows/13"), to be put back
//! as it was. Text Hatbot pastes is offered without being placed, so the window hears when an app
//! reads it, and is kept out of the clipboard's history.

use std::cell::RefCell;
use std::time::Duration;

use tokio::sync::oneshot;
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardOwner, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::UI::WindowsAndMessaging::{WM_DESTROYCLIPBOARD, WM_RENDERALLFORMATS, WM_RENDERFORMAT};
use windows::core::w;

use crate::computer::{Clip, Result};

const CF_UNICODETEXT: u32 = 13;
const PREFIX: &str = "windows/";

struct Offered {
    text: Vec<u16>,
    read: Option<oneshot::Sender<()>>,
}

thread_local! {
    static OFFERED: RefCell<Option<Offered>> = const { RefCell::new(None) };
}

/// Formats whose data is a GDI object or the owner's own, not memory that can be copied.
fn copyable(f: u32) -> bool {
    !matches!(f, 2 | 3 | 9 | 14 | 0x80 | 0x82 | 0x83 | 0x8e | 0x200..=0x3ff)
}

/// Another app may have it open for a moment.
fn open(h: HWND) -> Result<()> {
    for _ in 0..10 {
        // SAFETY: no pointers.
        if unsafe { OpenClipboard(Some(h)) }.is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("Another app is holding the clipboard.".into())
}

fn global(bytes: &[u8]) -> Option<HGLOBAL> {
    // SAFETY: the memory is as big as what's copied in, and handed to the clipboard after.
    unsafe {
        let g = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).ok()?;
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(g);
        Some(g)
    }
}

pub fn read(h: HWND) -> Result<Option<Clip>> {
    open(h)?;
    let mut out = Vec::new();
    // SAFETY: the clipboard is open until CloseClipboard; each handle is locked only while copied.
    unsafe {
        let mut f = EnumClipboardFormats(0);
        while f != 0 {
            if copyable(f)
                && let Ok(data) = GetClipboardData(f)
                && !data.is_invalid()
            {
                let g = HGLOBAL(data.0);
                let p = GlobalLock(g) as *const u8;
                if !p.is_null() {
                    out.push((format!("{PREFIX}{f}"), std::slice::from_raw_parts(p, GlobalSize(g)).to_vec()));
                    let _ = GlobalUnlock(g);
                }
            }
            f = EnumClipboardFormats(f);
        }
        let _ = CloseClipboard();
    }
    Ok((!out.is_empty()).then_some(Clip(out)))
}

pub fn write(h: HWND, clip: Option<Clip>) -> Result<oneshot::Receiver<()>> {
    let (tx, rx) = oneshot::channel();
    open(h)?;
    OFFERED.with(|o| o.borrow_mut().take());
    // SAFETY: the clipboard is open, and each global given to it is its own from then on.
    unsafe {
        let _ = EmptyClipboard();
        let entries = clip.map(|c| c.0).unwrap_or_default();
        let text = entries.iter().find(|(m, _)| m == "text/plain;charset=utf-8");
        if let Some((_, text)) = text {
            let mut wide: Vec<u16> = String::from_utf8_lossy(text).encode_utf16().collect();
            wide.push(0);
            OFFERED.with(|o| *o.borrow_mut() = Some(Offered { text: wide, read: Some(tx) }));
            let _ = SetClipboardData(CF_UNICODETEXT, None);
            for name in [w!("ExcludeClipboardContentFromMonitorProcessing"), w!("CanIncludeInClipboardHistory")] {
                let f = RegisterClipboardFormatW(name);
                if f != 0
                    && let Some(g) = global(&0u32.to_le_bytes())
                {
                    let _ = SetClipboardData(f, Some(HANDLE(g.0)));
                }
            }
        } else {
            for (mime, bytes) in &entries {
                let Some(f) = mime.strip_prefix(PREFIX).and_then(|f| f.parse::<u32>().ok()) else { continue };
                if let Some(g) = global(bytes) {
                    let _ = SetClipboardData(f, Some(HANDLE(g.0)));
                }
            }
            let _ = tx.send(());
        }
        let _ = CloseClipboard();
    }
    Ok(rx)
}

/// Places the offered text, for an app asking for it now.
fn render() {
    OFFERED.with(|o| {
        let mut o = o.borrow_mut();
        let Some(offered) = o.as_mut() else { return };
        let bytes: Vec<u8> = offered.text.iter().flat_map(|c| c.to_le_bytes()).collect();
        if let Some(g) = global(&bytes) {
            // SAFETY: Windows opened the clipboard for this message; the global is its own from here.
            let _ = unsafe { SetClipboardData(CF_UNICODETEXT, Some(HANDLE(g.0))) };
        }
        if let Some(tx) = offered.read.take() {
            let _ = tx.send(());
        }
    });
}

/// The clipboard's messages to the window; None for any other.
pub fn message(h: HWND, msg: u32, wp: WPARAM) -> Option<LRESULT> {
    match msg {
        WM_RENDERFORMAT if wp.0 as u32 == CF_UNICODETEXT => render(),
        WM_RENDERFORMAT => {}
        // The agent is quitting while it holds the clipboard: what it offered stays.
        WM_RENDERALLFORMATS => {
            // SAFETY: no pointers.
            if open(h).is_ok() {
                if unsafe { GetClipboardOwner() }.ok() == Some(h) {
                    render();
                }
                let _ = unsafe { CloseClipboard() };
            }
        }
        WM_DESTROYCLIPBOARD => OFFERED.with(|o| drop(o.borrow_mut().take())),
        _ => return None,
    }
    Some(LRESULT(0))
}
