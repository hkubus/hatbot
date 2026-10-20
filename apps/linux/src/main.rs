mod ui;

use adw::prelude::*;
use gtk::{gdk, glib};

const APP_ID: &str = "ovh.gaycats.Hatbot";

fn main() -> glib::ExitCode {
    let app = adw::Application::builder().application_id(APP_ID).build();
    app.connect_startup(|app| {
        let css = gtk::CssProvider::new();
        css.load_from_string(include_str!("ui/style.css"));
        if let Some(display) = gdk::Display::default() {
            gtk::style_context_add_provider_for_display(
                &display,
                &css,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
        }
        app.set_accels_for_action("window.close", &["<Control>w"]);
        app.set_accels_for_action("app.quit", &["<Control>q"]);
        let quit = gtk::gio::SimpleAction::new("quit", None);
        let weak = app.downgrade();
        quit.connect_activate(move |_, _| {
            if let Some(app) = weak.upgrade() {
                app.quit();
            }
        });
        app.add_action(&quit);
    });
    app.connect_activate(|app| {
        if let Some(window) = app.active_window() {
            window.present();
            return;
        }
        let window = ui::window::Window::new(app);
        window.window.present();
        // The window owns the app's state; it lives as long as the window does.
        let keep = std::cell::RefCell::new(Some(window.clone()));
        window.window.connect_destroy(move |_| {
            keep.take();
        });
    });
    app.run()
}
