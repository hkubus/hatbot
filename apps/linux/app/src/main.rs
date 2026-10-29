// `hatbot` opens the window, in the running daemon if there is one; `hatbot --daemon` runs windowless
// at login; `hatbot --banner` is the on-screen banner the daemon shows while it uses this computer.
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
    if instance::ask_running(!daemon) {
        return;
    }
    let mut d = iced::daemon(move || app::boot(!daemon), app::update, app::view)
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
