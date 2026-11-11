//! A thread that watches for the screen locking and for the owner's input, the way Wayland's idle
//! notifications do.

use std::time::Duration;

use objc2_core_foundation::{CFBoolean, CFString};
use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType, CGSessionCopyCurrentDictionary};
use tokio::sync::mpsc;

use crate::activity::{NOTICE_MS, QUIET_MS};
use crate::computer::SessionEvent;

pub fn start(events: mpsc::UnboundedSender<SessionEvent>) {
    let _ = std::thread::Builder::new().name("hatbot-session".into()).spawn(move || watch(events));
}

fn locked() -> bool {
    let Some(session) = CGSessionCopyCurrentDictionary() else { return false };
    // SAFETY: the session dictionary's keys are strings.
    let session = unsafe { session.cast_unchecked::<CFString, objc2_core_foundation::CFType>() };
    session
        .get(&CFString::from_static_str("CGSSessionScreenIsLocked"))
        .and_then(|v| v.downcast_ref::<CFBoolean>().map(|b| b.as_bool()))
        .unwrap_or(false)
}

/// Seconds since any input, Hatbot's own included; the core leaves that out.
fn idle() -> f64 {
    CGEventSource::seconds_since_last_event_type(CGEventSourceStateID::HIDSystemState, CGEventType(u32::MAX))
}

fn watch(events: mpsc::UnboundedSender<SessionEvent>) {
    let (notice, quiet_after) = (NOTICE_MS as f64 / 1000.0, QUIET_MS as f64 / 1000.0);
    let mut was_locked = locked();
    if events.send(SessionEvent::Locked(was_locked)).is_err() {
        return;
    }
    let mut last = idle();
    let mut quiet = false;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let now_locked = locked();
        if now_locked != was_locked {
            was_locked = now_locked;
            if events.send(SessionEvent::Locked(now_locked)).is_err() {
                return;
            }
        }
        let i = idle();
        if i + 0.1 < last {
            if last >= notice || quiet {
                let _ = events.send(SessionEvent::Resumed);
            }
            quiet = false;
        } else if !quiet && i >= quiet_after {
            quiet = true;
            if events.send(SessionEvent::Quiet).is_err() {
                return;
            }
        }
        last = i;
    }
}
