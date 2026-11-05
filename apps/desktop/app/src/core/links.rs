// hatbot:// links, as the brain's ntfy notifications send them (apps/brain/src/notify.ts's appLink)
// and `hatbot --open` takes them, to the web app's pages.

pub fn web_path(link: &str) -> String {
    let page = link.strip_prefix("hatbot://").unwrap_or(link).trim_matches('/');
    let (page, query) = page.split_once('?').unwrap_or((page, ""));
    let id =
        |prefix: &str| page.strip_prefix(prefix).filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()));
    if let Some(id) = id("approvals/") {
        let approve = if query == "approve=1" { "&approve=1" } else { "" };
        return format!("/?approval={id}{approve}");
    }
    if let Some(id) = id("threads/") {
        return format!("/chat/{id}");
    }
    let plain = page.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-_".contains(&b));
    match page {
        "" | "chat" | "new" => "/".into(),
        _ if plain => format!("/{page}"),
        _ => "/".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::web_path;

    #[test]
    fn a_notifications_link_opens_its_page() {
        assert_eq!(web_path("hatbot://approvals/12?approve=1"), "/?approval=12&approve=1");
        assert_eq!(web_path("hatbot://approvals/12"), "/?approval=12");
        assert_eq!(web_path("hatbot://threads/7"), "/chat/7");
        assert_eq!(web_path("hatbot://tasks/3"), "/tasks/3");
        assert_eq!(web_path("settings"), "/settings");
        assert_eq!(web_path("hatbot://chat"), "/");
    }

    #[test]
    fn a_link_that_could_leave_the_site_opens_the_chat() {
        for l in ["hatbot://..%2f", "hatbot:////evil.example", "hatbot://a b"] {
            assert_eq!(web_path(l), "/", "{l}");
        }
    }
}
