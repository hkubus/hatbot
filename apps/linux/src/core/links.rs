// hatbot:// links: ntfy's click links when Settings → Notifications opens the app, and links in
// messages. As iOS's AppLink reads them.
use gtk::glib;

#[derive(Debug, Clone, PartialEq)]
pub enum Link {
    Task(i64),
    Approval(i64),
    Schedule(i64),
    Trigger(i64),
    Box(i64),
    New,
    Live,
    Tasks,
    Memory(String),
    /// No URL has it: search's watchers open it.
    Watcher(i64),
    /// No URL has it: Spend's Limits opens Settings at its limits.
    Spending,
}

impl Link {
    /// hatbot://tasks/12, hatbot://approvals/5, hatbot://schedules/2, hatbot://triggers/3,
    /// hatbot://boxes/4; hatbot://new, hatbot://live, hatbot://tasks; hatbot://memory/notes/servers.md.
    pub fn parse(url: &str) -> Option<Link> {
        let (scheme, rest) = url.split_once("://")?;
        if !scheme.eq_ignore_ascii_case("hatbot") {
            return None;
        }
        let rest = rest.split(['?', '#']).next().unwrap_or("");
        let mut parts = rest.split('/').filter(|p| !p.is_empty());
        let host = parts.next()?;
        let parts: Vec<&str> = parts.collect();
        Some(match (host, parts.as_slice()) {
            ("new", []) => Link::New,
            ("live", []) => Link::Live,
            ("tasks", []) => Link::Tasks,
            ("memory", [_, ..]) => {
                let path = parts.join("/");
                Link::Memory(
                    glib::Uri::unescape_string(&path, None).map_or(path, |p| p.to_string()),
                )
            }
            (_, [id]) => {
                let id = id.parse().ok()?;
                match host {
                    "tasks" => Link::Task(id),
                    "approvals" => Link::Approval(id),
                    "schedules" => Link::Schedule(id),
                    "triggers" => Link::Trigger(id),
                    "boxes" => Link::Box(id),
                    _ => return None,
                }
            }
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_links_it_knows_and_nothing_else() {
        assert_eq!(Link::parse("HATBOT://tasks/12"), Some(Link::Task(12)));
        assert_eq!(Link::parse("hatbot://tasks"), Some(Link::Tasks));
        assert_eq!(
            Link::parse("hatbot://memory/notes/my%20servers.md"),
            Some(Link::Memory("notes/my servers.md".into()))
        );
        assert_eq!(Link::parse("hatbot://tasks/1/2"), None);
        assert_eq!(Link::parse("hatbot://tasks/x"), None);
        assert_eq!(Link::parse("https://tasks/1"), None);
    }
}
