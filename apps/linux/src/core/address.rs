// The brain's address as typed at sign-in. Never plain http: the token goes with every request,
// and a laptop joins networks you don't control (as on iOS).
use gtk::glib;

pub const API_PREFIX: &str = "/api/v1";

/// "https://host/" or "host" → "https://host"; a pasted ".../api/v1" is dropped. None for http
/// or anything that isn't an address.
pub fn server_url(input: &str) -> Option<String> {
    let mut s = input.trim().to_string();
    if s.is_empty() {
        return None;
    }
    if !s.contains("://") {
        s = format!("https://{s}");
    }
    while s.ends_with('/') {
        s.pop();
    }
    if let Some(rest) = s.strip_suffix(API_PREFIX) {
        s = rest.to_string();
    }
    let uri = glib::Uri::parse(&s, glib::UriFlags::NONE).ok()?;
    if !uri.scheme().eq_ignore_ascii_case("https") || uri.host().is_none_or(|h| h.is_empty()) {
        return None;
    }
    // "HTTPS://" would be saved as typed, and nothing after should have to compare cases.
    Some(format!("https{}", &s[uri.scheme().len()..]))
}

pub fn is_plain_http(input: &str) -> bool {
    input.trim().to_ascii_lowercase().starts_with("http://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_is_refused_and_a_bare_host_becomes_https() {
        assert_eq!(server_url("http://hatbot.lan"), None);
        assert!(is_plain_http(" HTTP://hatbot.lan"));
        assert_eq!(
            server_url(" HTTPS://hatbot.example.com/api/v1/ ").as_deref(),
            Some("https://hatbot.example.com")
        );
        assert_eq!(
            server_url("hatbot.example.com:8443").as_deref(),
            Some("https://hatbot.example.com:8443")
        );
    }
}
