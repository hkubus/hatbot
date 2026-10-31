use hatbot::core::thread::matching_commands;

fn names(draft: &str, incognito: bool) -> Vec<&'static str> {
    matching_commands(draft, incognito).iter().map(|c| c.name).collect()
}

#[test]
fn a_slash_lists_the_commands_its_name_could_be() {
    assert_eq!(names("/", false).len(), 5);
    assert_eq!(names("/Re", false), ["remember"]);
}

#[test]
fn a_path_or_a_finished_command_lists_none() {
    assert!(names("/etc/hosts", false).is_empty());
    assert!(names("/task fix CI", false).is_empty());
    assert!(names("hi /", false).is_empty());
}

#[test]
fn incognito_lists_only_commands_that_dont_outlast_it() {
    assert_eq!(names("/", true), ["new", "stop"]);
}
