//! Monitors and their pixels, through GDI. The process is per-monitor DPI aware (Tauri makes it so),
//! so what Windows says is in physical pixels.

use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, HDC, HMONITOR,
    MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MONITORINFOEXW, MonitorFromWindow, ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo, GetForegroundWindow, GetIconInfo, HICON, ICONINFO,
};
use windows::core::BOOL;

use crate::computer::{Frame, Output, Result};

pub struct Monitor {
    /// "\\.\DISPLAY1".
    pub name: String,
    pub rect: RECT,
    pub scale: f64,
}

impl Monitor {
    pub fn output(&self) -> Output {
        let (w, h) = ((self.rect.right - self.rect.left) as f64, (self.rect.bottom - self.rect.top) as f64);
        Output {
            name: self.name.clone(),
            width: (w / self.scale).round() as u32,
            height: (h / self.scale).round() as u32,
            scale: self.scale,
        }
    }

    /// A point on it in its logical pixels, on the screen in physical ones.
    pub fn physical(&self, x: f64, y: f64) -> (i32, i32) {
        (self.rect.left + (x * self.scale).round() as i32, self.rect.top + (y * self.scale).round() as i32)
    }
}

fn monitor(handle: HMONITOR) -> Option<Monitor> {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    // SAFETY: a MONITORINFOEXW starts with the MONITORINFO it extends, and cbSize says which it is.
    if !unsafe { GetMonitorInfoW(handle, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) }.as_bool() {
        return None;
    }
    let len = info.szDevice.iter().position(|c| *c == 0).unwrap_or(info.szDevice.len());
    let (mut dx, mut dy) = (96u32, 96u32);
    // SAFETY: plain out-parameters.
    let _ = unsafe { GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    Some(Monitor {
        name: String::from_utf16_lossy(&info.szDevice[..len]),
        rect: info.monitorInfo.rcMonitor,
        scale: dx.max(48) as f64 / 96.0,
    })
}

pub fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn each(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        // SAFETY: `data` is the Vec below, alive for the whole enumeration.
        unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) }.push(h);
        true.into()
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    // SAFETY: the callback only pushes onto `handles`.
    let _ = unsafe { EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut handles as *mut _ as isize)) };
    handles.into_iter().filter_map(monitor).collect()
}

pub fn named(name: &str) -> Result<Monitor> {
    monitors().into_iter().find(|m| m.name == name).ok_or_else(|| format!("There's no monitor {name} any more."))
}

/// The monitor with the window in front.
pub fn focused() -> Result<Monitor> {
    // SAFETY: no pointers.
    let h = unsafe { MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY) };
    monitor(h).ok_or_else(|| "There's no monitor.".into())
}

pub fn capture(m: &Monitor) -> Result<Frame> {
    let (w, h) = (m.rect.right - m.rect.left, m.rect.bottom - m.rect.top);
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    // SAFETY: every GDI object made here is released before returning, and GetDIBits writes at most
    // h rows of w 32-bit pixels into `bgra`.
    let (copied, lines) = unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let copied = BitBlt(mem, 0, 0, w, h, Some(screen), m.rect.left, m.rect.top, SRCCOPY | CAPTUREBLT).is_ok();
        if copied {
            draw_pointer(mem, m);
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(bgra.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        (copied, lines)
    };
    if !copied || lines == 0 {
        return Err("Can't capture the screen.".into());
    }
    let rgb = bgra.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0]]).collect();
    Ok(Frame { width: w as u32, height: h as u32, rgb })
}

/// GDI's capture leaves the pointer out; the brain's screenshots show it.
unsafe fn draw_pointer(dc: HDC, m: &Monitor) {
    let mut ci = CURSORINFO { cbSize: size_of::<CURSORINFO>() as u32, ..Default::default() };
    // SAFETY: plain out-parameters; the icon's bitmaps GetIconInfo makes are ours to delete.
    unsafe {
        if GetCursorInfo(&mut ci).is_err() || ci.flags.0 & CURSOR_SHOWING.0 == 0 {
            return;
        }
        let icon = HICON(ci.hCursor.0);
        let mut ii = ICONINFO::default();
        if GetIconInfo(icon, &mut ii).is_err() {
            return;
        }
        let x = ci.ptScreenPos.x - ii.xHotspot as i32 - m.rect.left;
        let y = ci.ptScreenPos.y - ii.yHotspot as i32 - m.rect.top;
        let _ = DrawIconEx(dc, x, y, icon, 0, 0, 0, None, DI_NORMAL);
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(ii.hbmMask.into());
        }
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(ii.hbmColor.into());
        }
    }
}
