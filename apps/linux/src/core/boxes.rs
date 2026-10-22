// Where a box's web view may go, as BoxNavigation in apps/ios/Hatbot/Core/Boxes.swift. Its page stays
// put: links to web pages open in your browser, and anything else that would take it away is refused.
use gtk::glib;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    /// A web page the box links to, opened in your browser.
    Open(String),
    /// Refused; the page stays.
    Refuse,
    /// Refused: the page tried to leave, or to load itself again.
    Leave,
}

/// `new_window`: a popup or a link to a new tab. `link`: a link you followed. `address`: the box's
/// page. `loaded`: that page is showing, after which it moves only within itself.
pub fn decide(url: &str, new_window: bool, link: bool, address: &str, loaded: bool) -> Navigation {
    let parsed = glib::Uri::parse(url, glib::UriFlags::ENCODED).ok();
    let scheme = parsed
        .as_ref()
        .map(|u| u.scheme().to_lowercase())
        .unwrap_or_default();
    let web = scheme == "http" || scheme == "https";
    if new_window {
        return if web && !same_page(url, address) {
            Navigation::Open(url.into())
        } else {
            Navigation::Refuse
        };
    }
    // Frames inside the page, which its CSP keeps to about:blank and srcdoc. WebKitGTK doesn't say
    // which frame a navigation is for; the main frame going there shows as a commit off the page.
    if scheme == "about" {
        return Navigation::Allow;
    }
    if same_page(url, address) {
        let fragment = parsed.and_then(|u| u.fragment()).is_some();
        return if !loaded || fragment {
            Navigation::Allow
        } else {
            Navigation::Leave
        };
    }
    if link && web {
        Navigation::Open(url.into())
    } else {
        Navigation::Leave
    }
}

/// The same page, whatever its fragment.
pub fn same_page(a: &str, b: &str) -> bool {
    let parse = |s: &str| glib::Uri::parse(s, glib::UriFlags::ENCODED).ok();
    let (Some(a), Some(b)) = (parse(a), parse(b)) else {
        return false;
    };
    let host = |u: &glib::Uri| u.host().map(|h| h.to_lowercase());
    a.scheme().eq_ignore_ascii_case(&b.scheme())
        && host(&a) == host(&b)
        && a.port() == b.port()
        && a.path() == b.path()
        && a.query() == b.query()
}
