// Search's snippets (Search.swift on iOS): the brain marks each match between \u{2} and \u{3}.
const START: char = '\u{2}';
const END: char = '\u{3}';

/// A snippet's runs of text, each with whether it's a match. The markers aren't in them.
pub fn parts(snippet: &str) -> Vec<(String, bool)> {
    let mut out = vec![];
    let mut run = String::new();
    let mut matched = false;
    for c in snippet.chars() {
        if c == START || c == END {
            if !run.is_empty() {
                out.push((std::mem::take(&mut run), matched));
            }
            matched = c == START;
        } else {
            run.push(c);
        }
    }
    if !run.is_empty() {
        out.push((run, matched));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_are_marked_and_the_markers_dropped() {
        assert_eq!(
            parts("…the \u{2}salmon\u{3} tins\u{3}, \u{2}six\u{3}"),
            vec![
                ("…the ".into(), false),
                ("salmon".into(), true),
                (" tins".into(), false),
                (", ".into(), false),
                ("six".into(), true),
            ]
        );
    }
}
