// Notifications for what waits on you and tasks that end, with their buttons; a button pressed comes
// back to the daemon as a `Msg::Notice`.
use crate::core::notify::Shown;
use crate::daemon::{self, Msg};

/// A plain one, saying something happened.
pub fn tell(text: &str) {
    show(Shown { key: String::new(), summary: "Hatbot".into(), body: text.into(), actions: vec![] }, false);
}

fn pressed(key: &str, action: String) {
    if !key.is_empty() {
        daemon::send(Msg::Notice { key: key.to_string(), action });
    } else if action == "default" {
        daemon::send(Msg::Open(None));
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    use std::sync::{Arc, LazyLock, Mutex};

    use notify_rust::{Hint, Notification, NotificationHandle, NotificationResponse, Timeout};

    use crate::core::notify::Shown;
    use crate::desk::system::APP_ID;

    static SHOWN: LazyLock<Mutex<HashMap<String, Arc<NotificationHandle>>>> = LazyLock::new(Default::default);

    pub fn show(s: Shown, lasting: bool) {
        tauri::async_runtime::spawn(async move {
            let mut n = Notification::new();
            n.appname("Hatbot").summary(&s.summary).body(&plain(&s.body)).icon(APP_ID);
            n.hint(Hint::DesktopEntry(APP_ID.into()));
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
            if !s.key.is_empty() {
                SHOWN.lock().unwrap().insert(s.key.clone(), h.clone());
            }
            let key = s.key.clone();
            h.wait_for_action_async(|r| match r {
                NotificationResponse::Default => super::pressed(&key, "default".into()),
                NotificationResponse::Action(a) if a != "__closed" => super::pressed(&key, a.clone()),
                _ => {}
            })
            .await;
            let mut shown = SHOWN.lock().unwrap();
            if shown.get(&key).is_some_and(|x| Arc::ptr_eq(x, &h)) {
                shown.remove(&key);
            }
        });
    }

    pub fn close(key: &str) {
        let Some(h) = SHOWN.lock().unwrap().remove(key) else { return };
        tauri::async_runtime::spawn(async move { h.close_async().await });
    }

    /// Notification servers read a little markup in the body; what a bot or a page wrote must show as written.
    fn plain(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    }
}

#[cfg(windows)]
mod imp {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};
    use windows::core::{HSTRING, IInspectable, Interface};

    use crate::core::notify::Shown;
    use crate::desk::system::APP_ID;

    const GROUP: &str = "hatbot";

    fn xml(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }

    fn toast(s: &Shown, lasting: bool) -> windows::core::Result<ToastNotification> {
        let actions: String = s
            .actions
            .iter()
            .filter(|(id, _)| id != "default")
            .map(|(id, label)| format!(r#"<action content="{}" arguments="{}"/>"#, xml(label), xml(id)))
            .collect();
        let scenario = if lasting { r#" scenario="reminder""# } else { "" };
        let doc = format!(
            r#"<toast launch="default"{scenario}><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual><actions>{actions}</actions></toast>"#,
            xml(&s.summary),
            xml(&s.body)
        );
        let d = XmlDocument::new()?;
        d.LoadXml(&HSTRING::from(doc))?;
        let t = ToastNotification::CreateToastNotification(&d)?;
        if !s.key.is_empty() {
            t.SetTag(&HSTRING::from(&s.key))?;
            t.SetGroup(&HSTRING::from(GROUP))?;
        }
        let key = s.key.clone();
        t.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
            let action = args
                .as_ref()
                .and_then(|a| a.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|a| a.Arguments().ok())
                .map(|a| a.to_string())
                .filter(|a| !a.is_empty())
                .unwrap_or_else(|| "default".into());
            super::pressed(&key, action);
            Ok(())
        }))?;
        Ok(t)
    }

    pub fn show(s: Shown, lasting: bool) {
        let shown = toast(&s, lasting)
            .and_then(|t| ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?.Show(&t));
        if let Err(e) = shown {
            eprintln!("hatbot: a notification didn't show: {e}");
        }
    }

    pub fn close(key: &str) {
        if let Ok(h) = ToastNotificationManager::History() {
            let _ = h.RemoveGroupedTagWithId(&HSTRING::from(key), &HSTRING::from(GROUP), &HSTRING::from(APP_ID));
        }
    }
}

pub use imp::{close, show};
