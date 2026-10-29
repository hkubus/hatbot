// `hatbot` opens the window, in the running daemon if there is one; `hatbot --daemon` runs windowless
// at login; `hatbot --open tasks` opens it on a page (see `pages::link`); `hatbot --banner` is the on-screen banner the daemon shows while it uses this computer.
use hatbot::desk::{banner, instance};
use hatbot::ui::{app, theme};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let _ = rustls::crypto::ring::default_provider().install_default();
    if args.first().map(String::as_str) == Some("--banner") {
        if let Err(e) = banner::run(args.get(1).cloned()) {
            eprintln!("hatbot: {e}");
        }
        return;
    }
    let daemon = args.iter().any(|a| a == "--daemon");
    let page = args
        .iter()
        .position(|a| a == "--open")
        .and_then(|i| args.get(i + 1))
        .or_else(|| args.iter().find(|a| a.starts_with("hatbot://")))
        .cloned();
    if instance::ask_running(!daemon, page.as_deref()) {
        return;
    }
    let mut d = iced::daemon(move || app::boot(!daemon, page.clone()), app::update, app::view)
        .title(app::title)
        .theme(app::theme)
        .subscription(app::subscription)
        .default_font(theme::TEXT)
        .antialiasing(true);
    for f in theme::FONTS {
        d = d.font(f);
    }
    if let Err(e) = d.run() {
        eprintln!("hatbot: {e}");
        std::process::exit(1);
    }
}
