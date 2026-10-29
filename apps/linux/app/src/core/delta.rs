/// A streaming reply's text with a delta added (withDelta in the web app). `at` is where `text`
/// starts in the reply, in UTF-16 units as the brain counts: the part already shown, because the
/// page was read after that text was sent, isn't added twice.
pub fn added(text: &str, shown: &str, at: Option<usize>) -> String {
    let Some(at) = at else {
        return format!("{shown}{text}");
    };
    let have: usize = shown.chars().map(char::len_utf16).sum();
    let mut skip = have.saturating_sub(at);
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if skip == 0 {
            break;
        }
        skip = skip.saturating_sub(c.len_utf16());
        start = i + c.len_utf8();
    }
    if skip > 0 {
        return shown.to_string();
    }
    format!("{shown}{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delta_the_page_already_has_is_not_added_twice_counting_utf16() {
        // "🎩" is two UTF-16 units: the brain's `at` counts them as JavaScript does.
        assert_eq!(added("🎩 b", "🎩 hi", Some(0)), "🎩 hi");
        assert_eq!(added("hi there", "🎩 hi", Some(3)), "🎩 hi there");
        assert_eq!(added(" more", "🎩 hi", Some(5)), "🎩 hi more");
        assert_eq!(added("x", "a", None), "ax");
    }
}
