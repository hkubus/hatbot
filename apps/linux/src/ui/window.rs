// The window: sign-in until there's a token, then the shell. A 401 from the brain, or signing out,
// goes back to sign-in.
use std::cell::RefCell;
use std::rc::{Rc, Weak};

use adw::prelude::*;
use gtk::{gio, glib};
use hatbot::net::api::Api;
use hatbot::net::vault;
use hatbot::session;
use hatbot::store::{Change, Listener, Store};

use super::shell::Shell;
use super::signin;

pub struct Window {
    pub window: adw::ApplicationWindow,
    toasts: adw::ToastOverlay,
    signed_in: RefCell<Option<SignedIn>>,
    menu: gio::Menu,
}

struct SignedIn {
    store: Store,
    _shell: Shell,
    _listener: Listener,
}

impl Window {
    pub fn new(app: &adw::Application) -> Rc<Window> {
        let toasts = adw::ToastOverlay::new();
        let window = adw::ApplicationWindow::builder()
            .application(app)
            .title("Hatbot")
            .default_width(1100)
            .default_height(760)
            .width_request(360)
            .height_request(400)
            .content(&toasts)
            .build();
        let menu = gio::Menu::new();
        let admin = gio::Menu::new();
        for (label, action) in [("Pause All", "win.pause"), ("Resume", "win.resume")] {
            let item = gio::MenuItem::new(Some(label), Some(action));
            item.set_attribute_value("hidden-when", Some(&"action-disabled".to_variant()));
            admin.append_item(&item);
        }
        menu.append_section(None, &admin);
        let app_section = gio::Menu::new();
        app_section.append(Some("Sign Out"), Some("win.sign-out"));
        app_section.append(Some("About Hatbot"), Some("win.about"));
        menu.append_section(None, &app_section);

        let this = Rc::new(Window {
            window,
            toasts,
            signed_in: RefCell::default(),
            menu,
        });
        this.add_actions();
        this.restore();
        this
    }

    fn add_actions(self: &Rc<Self>) {
        let pause = gio::SimpleAction::new("pause", None);
        let resume = gio::SimpleAction::new("resume", None);
        resume.set_enabled(false);
        for (action, value) in [(&pause, true), (&resume, false)] {
            let weak = Rc::downgrade(self);
            action.connect_activate(move |_, _| {
                let Some(w) = weak.upgrade() else { return };
                let weak = weak.clone();
                let set = move || {
                    let Some(store) = weak.upgrade().and_then(|w| w.store()) else {
                        return;
                    };
                    let weak = weak.clone();
                    glib::spawn_future_local(async move {
                        if let Err(e) = store.set_paused(value).await
                            && let Some(w) = weak.upgrade()
                        {
                            w.toast(&e.message);
                        }
                    });
                };
                if value {
                    w.confirm("Pause all?", "Pause All", set);
                } else {
                    set();
                }
            });
            self.window.add_action(action);
        }
        let sign_out = gio::SimpleAction::new("sign-out", None);
        let weak = Rc::downgrade(self);
        sign_out.connect_activate(move |_, _| {
            let Some(w) = weak.upgrade() else { return };
            let weak = weak.clone();
            w.confirm("Sign out of Hatbot?", "Sign Out", move || {
                if let Some(w) = weak.upgrade() {
                    w.sign_out();
                }
            });
        });
        self.window.add_action(&sign_out);
        let about = gio::SimpleAction::new("about", None);
        let weak = Rc::downgrade(self);
        about.connect_activate(move |_, _| {
            let Some(w) = weak.upgrade() else { return };
            let dialog = adw::AboutDialog::builder()
                .application_name("Hatbot")
                .application_icon("ovh.gaycats.Hatbot")
                .version(env!("CARGO_PKG_VERSION"))
                .license_type(gtk::License::MitX11)
                .website("https://git.gaycats.ovh/kubus/hatbot")
                .build();
            dialog.present(Some(&w.window));
        });
        self.window.add_action(&about);
    }

    fn confirm(&self, title: &str, button: &str, then: impl Fn() + 'static) {
        let dialog = adw::AlertDialog::new(Some(title), None);
        dialog.add_responses(&[("cancel", "Cancel"), ("go", button)]);
        dialog.set_response_appearance("go", adw::ResponseAppearance::Destructive);
        dialog.set_close_response("cancel");
        dialog.connect_response(Some("go"), move |_, _| then());
        dialog.present(Some(&self.window));
    }

    pub fn toast(&self, text: &str) {
        self.toasts.add_toast(adw::Toast::new(text));
    }

    pub fn store(&self) -> Option<Store> {
        self.signed_in.borrow().as_ref().map(|s| s.store.clone())
    }

    /// The token saved for the saved address, if there is one.
    fn restore(self: &Rc<Self>) {
        let Some(server) = vault::saved_server() else {
            self.show_signin(None);
            return;
        };
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let token = vault::load(&server).await;
            let Some(w) = weak.upgrade() else { return };
            match token {
                Some(token) => w.start(&server, token),
                None => w.show_signin(Some(&server)),
            }
        });
    }

    fn show_signin(self: &Rc<Self>, prefill: Option<&str>) {
        let weak = Rc::downgrade(self);
        let page = signin::page(prefill, move |server, token| {
            let Some(w) = weak.upgrade() else { return };
            let weak = Rc::downgrade(&w);
            glib::spawn_future_local(async move {
                let saved = vault::save(&server, &token).await;
                let Some(w) = weak.upgrade() else { return };
                if saved.is_err() {
                    w.toast("Couldn't keep the token: no keyring answered. Start GNOME Keyring, KWallet or KeePassXC's Secret Service.");
                    return;
                }
                vault::save_server(&server);
                w.start(&server, token);
            });
        });
        self.toasts.set_child(Some(&page));
    }

    fn start(self: &Rc<Self>, server: &str, token: String) {
        let api = Api::new(server, Some(token.clone()));
        let weak = Rc::downgrade(self);
        api.on_unauthorized(move || {
            if let Some(w) = weak.upgrade() {
                w.forget(&token);
            }
        });
        super::chart::set_api(api.clone());
        let store = Store::new(api);
        let shell = Shell::new(&store, &self.menu);
        self.toasts.set_child(Some(&shell.root));
        let listener = store.listen(self.listener());
        store.connect();
        self.signed_in.replace(Some(SignedIn {
            store,
            _shell: shell,
            _listener: listener,
        }));
        self.sync_actions();
    }

    fn listener(self: &Rc<Self>) -> impl Fn(&Change) + 'static {
        let weak: Weak<Window> = Rc::downgrade(self);
        move |change| {
            let Some(w) = weak.upgrade() else { return };
            match change {
                Change::Toast(text) => w.toast(text),
                Change::Paused => w.sync_actions(),
                _ => {}
            }
        }
    }

    fn sync_actions(&self) {
        let paused = self.store().map(|s| s.state().paused);
        for (name, enabled) in [
            ("pause", paused == Some(false)),
            ("resume", paused == Some(true)),
        ] {
            if let Some(a) = self
                .window
                .lookup_action(name)
                .and_downcast::<gio::SimpleAction>()
            {
                a.set_enabled(enabled);
            }
        }
    }

    fn sign_out(self: &Rc<Self>) {
        let Some(signed_in) = self.signed_in.take() else {
            return;
        };
        signed_in.store.disconnect();
        let api = signed_in.store.api().clone();
        let server = api.server().to_string();
        self.show_signin(Some(&server));
        glib::spawn_future_local(async move {
            session::logout(&api).await;
            vault::clear(&server).await;
        });
        self.sync_actions();
    }

    /// The brain no longer takes `token`: only while it's still this window's, since a late answer
    /// to an older session mustn't sign you out.
    fn forget(self: &Rc<Self>, token: &str) {
        let current = self.store().is_some_and(|s| s.api().token() == Some(token));
        if !current {
            return;
        }
        let Some(signed_in) = self.signed_in.take() else {
            return;
        };
        signed_in.store.disconnect();
        let server = signed_in.store.api().server().to_string();
        self.show_signin(Some(&server));
        self.toast("Signed out: Hatbot no longer accepts this computer's token.");
        glib::spawn_future_local(async move { vault::clear(&server).await });
        self.sync_actions();
    }
}
