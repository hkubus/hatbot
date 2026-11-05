//! Hatbot's desktop app, on Linux and Windows: the brain's web app in a window, with what only the
//! computer itself can do around it (the tray, notifications, the keyring, letting Hatbot use this
//! computer, and Hatbot run on it without a server).

mod commands;
pub mod core;
mod daemon;
mod desk;
mod window;

use tauri::RunEvent;

/// `hatbot` opens the window, in the running copy if there is one; `hatbot --daemon` runs windowless
/// at login; `hatbot --open tasks` or a `hatbot://` link opens it on a page.
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let open_window = !args.iter().any(|a| a == "--daemon");
    let page = daemon::page_of(&args);
    // The window's Wayland app id, which launchers match to ovh.gaycats.Hatbot.desktop.
    #[cfg(target_os = "linux")]
    gtk::glib::set_prgname(Some(desk::system::APP_ID));
    desk::system::register();
    let shared = daemon::Shared::default();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, argv, _| {
            daemon::send(daemon::Msg::Args(argv.into_iter().skip(1).collect()));
        }))
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![commands::state, commands::act])
        .setup(move |app| {
            daemon::start(app.handle().clone(), shared, open_window, page);
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("hatbot: {e}");
            std::process::exit(1);
        }
    };
    app.run(|_, event| {
        // Closing the last window leaves the app in the tray; only Quit ends it.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
