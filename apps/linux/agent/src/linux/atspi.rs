//! What's under a point or has the keyboard, from AT-SPI, in the shape desktop-agent gives the brain
//! for a page's elements. Wayland apps only know points within their own windows, so the window comes
//! from niri and the app from its process.

use std::collections::VecDeque;
use std::time::Duration;

use atspi::proxy::accessible::AccessibleProxy;
use atspi::proxy::component::ComponentProxy;
use atspi::{CoordType, ObjectRefOwned, Role, State};

use crate::computer::{InspectAt, Result};
use crate::protocol::AgentElement;

/// Most nodes read looking for the focus or a form's buttons.
const MAX_NODES: usize = 1500;
const TIMEOUT: Duration = Duration::from_secs(4);

pub struct Atspi {
    conn: zbus::Connection,
}

type Proxy = AccessibleProxy<'static>;

impl Atspi {
    pub async fn connect() -> Result<Self> {
        let a11y =
            tokio::time::timeout(Duration::from_secs(3), atspi::AccessibilityConnection::new())
                .await
                .map_err(|_| "The accessibility bus didn't answer.".to_string())?
                .map_err(|e| format!("No accessibility bus: {e}."))?;
        Ok(Self { conn: a11y.connection().clone() })
    }

    pub async fn inspect(&self, at: InspectAt) -> Result<Option<AgentElement>> {
        tokio::time::timeout(TIMEOUT, self.find(at))
            .await
            .map_err(|_| "The app's accessibility tree took too long to read.".to_string())?
            .map_err(|e| format!("Couldn't read the accessibility tree: {e}."))
    }

    async fn proxy(&self, r: &ObjectRefOwned) -> zbus::Result<Proxy> {
        let name = r.name().ok_or_else(|| zbus::Error::Failure("no bus name".into()))?.to_owned();
        AccessibleProxy::builder(&self.conn)
            .destination(name)?
            .path(r.path().to_owned())?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
    }

    async fn component(&self, p: &Proxy) -> zbus::Result<ComponentProxy<'static>> {
        ComponentProxy::builder(&self.conn)
            .destination(p.inner().destination().to_owned())?
            .path(p.inner().path().to_owned())?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
    }

    /// The apps on the bus whose process is `pid`, or all of them.
    async fn apps(&self, pid: Option<i32>) -> zbus::Result<Vec<Proxy>> {
        let root = AccessibleProxy::builder(&self.conn)
            .destination("org.a11y.atspi.Registry")?
            .path("/org/a11y/atspi/accessible/root")?
            .build()
            .await?;
        let dbus = zbus::fdo::DBusProxy::new(&self.conn).await?;
        let mut out = Vec::new();
        for r in root.get_children().await? {
            let Some(name) = r.name() else { continue };
            if let Some(pid) = pid {
                let theirs = dbus.get_connection_unix_process_id(name.clone().into()).await;
                if theirs.ok() != Some(pid as u32) {
                    continue;
                }
            }
            if let Ok(p) = self.proxy(&r).await {
                out.push(p);
            }
        }
        Ok(out)
    }

    /// An app's window: the one titled so, else the active one.
    async fn frame(&self, apps: &[Proxy], title: Option<&str>) -> zbus::Result<Option<Proxy>> {
        let mut active = None;
        for app in apps {
            for r in app.get_children().await.unwrap_or_default() {
                let Ok(w) = self.proxy(&r).await else { continue };
                if title.is_some() && w.name().await.ok().as_deref() == title {
                    return Ok(Some(w));
                }
                if active.is_none() && w.get_state().await.is_ok_and(|s| s.contains(State::Active))
                {
                    active = Some(w);
                }
            }
        }
        Ok(active)
    }

    async fn find(&self, at: InspectAt) -> zbus::Result<Option<AgentElement>> {
        let el = match at {
            InspectAt::Point { pid, title, x, y } => {
                let apps = self.apps(Some(pid)).await?;
                let Some(frame) = self.frame(&apps, Some(&title)).await? else { return Ok(None) };
                let mut cur = frame;
                // Each step gives the child at the point; the deepest is the element.
                for _ in 0..40 {
                    let c = self.component(&cur).await?;
                    let Ok(child) =
                        c.get_accessible_at_point(x as i32, y as i32, CoordType::Window).await
                    else {
                        break;
                    };
                    if child.is_null() {
                        break;
                    }
                    let next = self.proxy(&child).await?;
                    if same(&next, &cur) {
                        break;
                    }
                    cur = next;
                }
                cur
            }
            InspectAt::Focus { pid } => {
                let apps = self.apps(pid).await?;
                let Some(frame) = self.frame(&apps, None).await? else { return Ok(None) };
                match self.focused(frame).await? {
                    Some(f) => f,
                    None => return Ok(None),
                }
            }
        };
        self.element(&el).await.map(Some)
    }

    /// The focused element under a window, breadth first, into what's showing only.
    async fn focused(&self, frame: Proxy) -> zbus::Result<Option<Proxy>> {
        let mut queue = VecDeque::from([frame]);
        let mut seen = 0;
        while let Some(p) = queue.pop_front() {
            seen += 1;
            if seen > MAX_NODES {
                break;
            }
            let state = p.get_state().await.unwrap_or_default();
            if state.contains(State::Focused) {
                return Ok(Some(p));
            }
            if seen > 1 && !state.contains(State::Showing) {
                continue;
            }
            for r in p.get_children().await.unwrap_or_default() {
                if let Ok(c) = self.proxy(&r).await {
                    queue.push_back(c);
                }
            }
        }
        Ok(None)
    }

    async fn element(&self, p: &Proxy) -> zbus::Result<AgentElement> {
        let role = p.get_role().await?;
        let state = p.get_state().await.unwrap_or_default();
        let mut label = p.name().await.unwrap_or_default().trim().to_owned();
        if label.is_empty() {
            label = p.description().await.unwrap_or_default().trim().to_owned();
        }
        let label: String = label.chars().take(200).collect();
        let text_box =
            matches!(role, Role::Entry | Role::PasswordText | Role::Text | Role::Terminal)
                || matches!(role, Role::ComboBox if state.contains(State::Editable));
        let editable = state.contains(State::Editable) && text_box;
        let mut el = AgentElement {
            tag: p.get_role_name().await.unwrap_or_default(),
            role: aria(role).map(str::to_owned),
            kind: None,
            label,
            in_form: false,
            editable: Some(editable),
            secret: (role == Role::PasswordText).then_some(true),
            toggle: (matches!(
                role,
                Role::ToggleButton | Role::CheckBox | Role::PageTab | Role::Menu
            ) || state.contains(State::Expandable))
            .then_some(true),
            ..Default::default()
        };
        // Up the tree for a form, and for the nearest part with buttons in it.
        let mut cur = p.clone();
        let mut buttons_from: Option<Proxy> = None;
        for _ in 0..30 {
            let Ok(parent) = cur.parent().await else { break };
            if parent.is_null() {
                break;
            }
            let Ok(parent) = self.proxy(&parent).await else { break };
            if same(&parent, &cur) {
                break;
            }
            let prole = parent.get_role().await.unwrap_or(Role::Invalid);
            if matches!(prole, Role::Application | Role::Frame | Role::Window) {
                buttons_from.get_or_insert(parent.clone());
                break;
            }
            if prole == Role::Form {
                el.in_form = true;
                let (_, buttons) = self.buttons(&parent, p).await;
                el.submit_label = buttons.into_iter().next();
                buttons_from.get_or_insert(parent.clone());
                break;
            }
            if editable && buttons_from.is_none() && !self.buttons(&parent, p).await.1.is_empty() {
                buttons_from = Some(parent.clone());
            }
            cur = parent;
        }
        if editable && let Some(scope) = buttons_from {
            let (after, before) = self.buttons(&scope, p).await;
            let all: Vec<String> = after.into_iter().chain(before).collect();
            el.buttons_after = (!all.is_empty()).then_some(all);
        }
        Ok(el)
    }

    /// The buttons in a part of the tree, in order: those after `from` first, then those before.
    async fn buttons(&self, scope: &Proxy, from: &Proxy) -> (Vec<String>, Vec<String>) {
        let (mut before, mut after) = (Vec::new(), Vec::new());
        let mut passed = false;
        let mut stack = vec![scope.clone()];
        let mut seen = 0;
        while let Some(p) = stack.pop() {
            seen += 1;
            if seen > MAX_NODES / 3 {
                break;
            }
            if same(&p, from) {
                passed = true;
            }
            if p.get_role().await.is_ok_and(|r| r == Role::Button) {
                let name = p.name().await.unwrap_or_default().trim().to_owned();
                if passed {
                    after.push(name)
                } else {
                    before.push(name)
                }
                continue;
            }
            let children = p.get_children().await.unwrap_or_default();
            for r in children.iter().rev() {
                if let Ok(c) = self.proxy(r).await {
                    stack.push(c);
                }
            }
        }
        (after, before)
    }
}

fn same(a: &Proxy, b: &Proxy) -> bool {
    a.inner().destination() == b.inner().destination() && a.inner().path() == b.inner().path()
}

fn aria(role: Role) -> Option<&'static str> {
    Some(match role {
        Role::Button | Role::ToggleButton => "button",
        Role::CheckBox | Role::CheckMenuItem => "checkbox",
        Role::RadioButton | Role::RadioMenuItem => "radio",
        Role::Link => "link",
        Role::Entry | Role::PasswordText | Role::Text | Role::Terminal => "textbox",
        Role::ComboBox => "combobox",
        Role::MenuItem => "menuitem",
        Role::Menu => "menu",
        Role::PageTab => "tab",
        Role::Slider => "slider",
        Role::SpinButton => "spinbutton",
        Role::ListItem => "listitem",
        Role::TableCell => "cell",
        Role::Heading => "heading",
        Role::Image => "img",
        _ => return None,
    })
}
