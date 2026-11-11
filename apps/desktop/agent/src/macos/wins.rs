//! The windows on the screen, front to back. Their titles need the Screen Recording permission;
//! bringing one to the front needs Accessibility.

use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect};
use objc2_core_graphics::{
    CGPreflightScreenCaptureAccess, CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo,
    CGWindowListOption, kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName,
    kCGWindowOwnerPID, kCGWindowSharingState,
};

use super::ax;
use super::screen::Display;
use crate::computer::{Rect, Result, Window};

/// Smaller than this, a window is an app's helper, not one to work in.
const MIN_SIDE: f64 = 40.0;

struct Info {
    id: u64,
    pid: i32,
    title: String,
    app: String,
    bounds: CGRect,
    /// Its app keeps it out of captures.
    private: bool,
}

fn number(d: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    d.get(key)?.downcast_ref::<CFNumber>()?.as_i64()
}

fn text(d: &CFDictionary<CFString, CFType>, key: &CFString) -> String {
    d.get(key).and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string())).unwrap_or_default()
}

/// The ordinary windows on screen, front to back.
fn on_screen() -> Vec<Info> {
    let options = CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(options, 0) else { return Vec::new() };
    // SAFETY: the window list holds dictionaries keyed by strings.
    let list = unsafe { CFRetained::cast_unchecked::<CFArray<CFDictionary<CFString, CFType>>>(list) };
    // SAFETY: the keys are CoreGraphics' own constants.
    let (k_num, k_layer, k_bounds, k_name, k_owner, k_pid, k_sharing) = unsafe {
        (
            kCGWindowNumber,
            kCGWindowLayer,
            kCGWindowBounds,
            kCGWindowName,
            kCGWindowOwnerName,
            kCGWindowOwnerPID,
            kCGWindowSharingState,
        )
    };
    // Without the Screen Recording permission every other app's window reads as kept out of captures.
    let can_see = CGPreflightScreenCaptureAccess();
    list.iter()
        .filter_map(|d| {
            if number(&d, k_layer)? != 0 {
                return None;
            }
            let mut bounds = CGRect::default();
            let b = d.get(k_bounds)?.downcast::<CFDictionary>().ok()?;
            // SAFETY: a bounds dictionary, and a plain out-parameter.
            if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(&b), &mut bounds) } {
                return None;
            }
            if bounds.size.width < MIN_SIDE || bounds.size.height < MIN_SIDE {
                return None;
            }
            Some(Info {
                id: number(&d, k_num)? as u64,
                pid: number(&d, k_pid)? as i32,
                title: text(&d, k_name),
                app: text(&d, k_owner),
                bounds,
                private: can_see && number(&d, k_sharing) == Some(0),
            })
        })
        .collect()
}

fn front_pid() -> Option<i32> {
    NSWorkspace::sharedWorkspace().frontmostApplication().map(|a| a.processIdentifier())
}

/// The middle of the window in front, in global points.
pub fn front_center() -> Option<CGPoint> {
    let pid = front_pid()?;
    let w = on_screen().into_iter().find(|w| w.pid == pid)?;
    Some(CGPoint::new(w.bounds.origin.x + w.bounds.size.width / 2.0, w.bounds.origin.y + w.bounds.size.height / 2.0))
}

fn placed(b: CGRect, d: &Display) -> Option<Rect> {
    let center = CGPoint::new(b.origin.x + b.size.width / 2.0, b.origin.y + b.size.height / 2.0);
    d.contains(center).then_some(Rect {
        x: b.origin.x - d.bounds.origin.x,
        y: b.origin.y - d.bounds.origin.y,
        width: b.size.width,
        height: b.size.height,
    })
}

pub fn list(d: &Display) -> Vec<Window> {
    let front = front_pid();
    let mut focused_taken = false;
    on_screen()
        .into_iter()
        .map(|w| {
            let focused = !focused_taken && Some(w.pid) == front;
            focused_taken |= focused;
            Window {
                id: w.id,
                title: w.title,
                app_id: w.app,
                focused,
                pid: Some(w.pid),
                rect: placed(w.bounds, d),
                excluded: w.private,
            }
        })
        .collect()
}

/// Brings a window to the front: its app first, then the window, found among the app's by where it is.
pub fn focus(id: u64) -> Result<()> {
    let w = on_screen().into_iter().find(|w| w.id == id).ok_or("That window is gone.")?;
    let app =
        NSRunningApplication::runningApplicationWithProcessIdentifier(w.pid).ok_or("That window's app is gone.")?;
    let ax_app = ax::app(w.pid);
    let near = |a: f64, b: f64| (a - b).abs() <= 2.0;
    let window = ax::elements(&ax_app, "AXWindows").into_iter().find(|el| {
        let (Some(p), Some(s)) = (ax::position(el), ax::size(el)) else { return false };
        near(p.x, w.bounds.origin.x)
            && near(p.y, w.bounds.origin.y)
            && near(s.width, w.bounds.size.width)
            && near(s.height, w.bounds.size.height)
    });
    if let Some(window) = &window {
        // SAFETY: plain calls on a live element; a stale one only fails them.
        unsafe {
            window.perform_action(&CFString::from_static_str("AXRaise"));
        }
    }
    #[allow(deprecated)]
    app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
    for _ in 0..20 {
        if front_pid() == Some(w.pid) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    if window.is_none() && !ax::trusted() {
        return Err("macOS doesn't let Hatbot control the computer. Allow it in System Settings → Privacy & Security → Accessibility.".into());
    }
    Err("macOS didn't bring that window to the front.".into())
}
