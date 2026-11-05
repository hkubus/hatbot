use std::path::Path;

use hatbot::core::local::{brain_env, bun_build, format_env, lan_env, parse_env};

#[test]
fn setting_up_again_keeps_the_port_and_the_network_address() {
    let first = brain_env(&Default::default(), Path::new("/home/me/.local/share/hatbot/data"), 8457);
    assert_eq!(first["HATBOT_PUBLIC_URL"], "http://127.0.0.1:8457");
    let shared = lan_env(&first, Some("192.168.1.20"));
    let saved = parse_env(&format_env(&shared));
    let again = brain_env(&saved, Path::new("/home/me/.local/share/hatbot/data"), 8457);
    assert_eq!(again["HATBOT_HOST"], "0.0.0.0");
    assert_eq!(again["HATBOT_PUBLIC_URL"], "http://192.168.1.20:8457");
    assert_eq!(again["HATBOT_LOCAL"], "1");
}

#[test]
fn other_devices_reach_it_only_while_switched_on() {
    let env = brain_env(&Default::default(), Path::new("/data"), 8460);
    let on = lan_env(&env, Some("10.0.0.5"));
    assert_eq!((on["HATBOT_HOST"].as_str(), on["HATBOT_PUBLIC_URL"].as_str()), ("0.0.0.0", "http://10.0.0.5:8460"));
    let off = lan_env(&on, None);
    assert_eq!(
        (off["HATBOT_HOST"].as_str(), off["HATBOT_PUBLIC_URL"].as_str()),
        ("127.0.0.1", "http://127.0.0.1:8460")
    );
}

#[test]
fn bun_is_the_build_this_processor_runs() {
    assert_eq!(bun_build("x86_64", true).map(|b| b.0), Some("bun-linux-x64"));
    assert_eq!(bun_build("x86_64", false).map(|b| b.0), Some("bun-linux-x64-baseline"));
    assert_eq!(bun_build("aarch64", false).map(|b| b.0), Some("bun-linux-aarch64"));
    assert_eq!(bun_build("riscv64", false), None);
}
