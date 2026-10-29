// Desktop notifications for what waits on you and tasks that end, with their buttons.
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use notify_rust::{Hint, Notification, NotificationHandle, NotificationResponse, Timeout};

use super::inbox::{self, Outside};
use crate::core::notify::Shown;

static SHOWN: LazyLock<Mutex<HashMap<String, Arc<NotificationHandle>>>> = LazyLock::new(Default::default);

pub fn show(s: Shown, lasting: bool) {
    tokio::spawn(async move {
        let mut n = Notification::new();
        n.appname("Hatbot").summary(&s.summary).body(&plain(&s.body)).icon("ovh.gaycats.Hatbot");
        n.hint(Hint::DesktopEntry("ovh.gaycats.Hatbot".into()));
        for (id, label) in &s.actions {
            n.action(id, label);
        }
        if lasting {
            n.hint(Hint::Resident(true)).timeout(Timeout::Never);
        }
        if let Some(old) = SHOWN.lock().unwrap().get(&s.key) {
            n.id(old.id());
        }
        let Ok(h) = n.show_async().await else { return };
        let h = Arc::new(h);
        SHOWN.lock().unwrap().insert(s.key.clone(), h.clone());
        let key = s.key.clone();
        h.wait_for_action_async(|r| {
            let action = match r {
                NotificationResponse::Default => Some("default".to_string()),
                NotificationResponse::Action(a) if a != "__closed" => Some(a.clone()),
                _ => None,
            };
            if let Some(action) = action {
                inbox::send(Outside::Notice { key: key.clone(), action });
            }
        })
        .await;
        let mut shown = SHOWN.lock().unwrap();
        if shown.get(&key).is_some_and(|x| Arc::ptr_eq(x, &h)) {
            shown.remove(&key);
        }
    });
}

/// Takes one down: answered elsewhere, or no longer waiting.
pub fn close(key: &str) {
    let Some(h) = SHOWN.lock().unwrap().remove(key) else { return };
    tokio::spawn(async move { h.close_async().await });
}

/// Notification servers read a little markup in the body; what a bot or a page wrote must show as written.
fn plain(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
