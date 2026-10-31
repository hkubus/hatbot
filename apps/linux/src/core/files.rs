// A file's name as the cache can take it: one part, a name of its own, never a way out of the folder.
pub fn safe_file_name(name: &str) -> String {
    let name = name.replace(['/', '\\', '\0'], "_").replace("..", "__");
    let clipped: String = name.trim_start_matches('.').chars().take(200).collect();
    if clipped.is_empty() {
        "file".to_string()
    } else {
        clipped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_name_of_its_own_and_nothing_that_climbs_out() {
        assert_eq!(safe_file_name("photo.png"), "photo.png");
        // Whatever it's made of, it stays the folder's own file.
        for name in ["../../x.desktop", "..", ".", "", "x/../../y"] {
            let joined = std::path::Path::new("/cache").join(safe_file_name(name));
            assert_eq!(
                joined.parent(),
                Some(std::path::Path::new("/cache")),
                "{name}"
            );
        }
        for (name, out) in [
            ("../../x.desktop", "______x.desktop"),
            ("..", "__"),
            ("/etc/passwd", "_etc_passwd"),
            ("a\\b", "a_b"),
        ] {
            assert_eq!(safe_file_name(name), out);
        }
    }
}
