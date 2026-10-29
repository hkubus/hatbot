//! Whether the session is locked, from logind's LockedHint, which screen lockers set. A locker that
//! doesn't set it goes unseen: screenshots then show the lock screen and input goes nowhere.

use tokio::sync::mpsc;
use zbus::zvariant::OwnedObjectPath;

use crate::computer::SessionEvent;

#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Manager {
    fn get_session_by_pid(&self, pid: u32) -> zbus::Result<OwnedObjectPath>;
    fn list_sessions(&self) -> zbus::Result<Vec<(String, u32, String, String, OwnedObjectPath)>>;
}

#[zbus::proxy(
    interface = "org.freedesktop.login1.Session",
    default_service = "org.freedesktop.login1"
)]
trait Session {
    #[zbus(property)]
    fn locked_hint(&self) -> zbus::Result<bool>;
    #[zbus(property, name = "Type")]
    fn kind(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn active(&self) -> zbus::Result<bool>;
}

/// The owner's graphical session: this process's, or (from a systemd user service, which isn't in
/// one) their active Wayland one.
async fn session(conn: &zbus::Connection) -> zbus::Result<SessionProxy<'static>> {
    let manager = ManagerProxy::new(conn).await?;
    if let Ok(path) = manager.get_session_by_pid(std::process::id()).await {
        return SessionProxy::builder(conn).path(path)?.build().await;
    }
    let uid = rustix::process::getuid().as_raw();
    for (_, user, _, _, path) in manager.list_sessions().await? {
        if user != uid {
            continue;
        }
        let s = SessionProxy::builder(conn).path(path)?.build().await?;
        if s.kind().await.is_ok_and(|k| k == "wayland") && s.active().await.unwrap_or(false) {
            return Ok(s);
        }
    }
    Err(zbus::Error::Failure("no graphical session".into()))
}

pub async fn watch(events: mpsc::UnboundedSender<SessionEvent>) {
    let run = async {
        let conn = zbus::Connection::system().await?;
        let s = session(&conn).await?;
        let mut changes = s.receive_locked_hint_changed().await;
        let _ = events.send(SessionEvent::Locked(s.locked_hint().await?));
        use futures_util::StreamExt;
        while let Some(c) = changes.next().await {
            if let Ok(on) = c.get().await {
                let _ = events.send(SessionEvent::Locked(on));
            }
        }
        zbus::Result::Ok(())
    };
    if let Err(e) = run.await {
        tracing::info!("can't follow the session's lock: {e}");
    }
}
