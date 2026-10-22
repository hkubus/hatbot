use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use hatbot::net::api::Api;
use hatbot::session;

use super::icon::Icon;

/// The page, and what it calls with the address and token once you're in.
pub fn page(prefill: Option<&str>, on_signed_in: impl Fn(String, String) + 'static) -> gtk::Widget {
    let mark = Icon::new("hat", 72);
    mark.add_css_class("signin-mark");
    mark.set_margin_bottom(12);
    let title = gtk::Label::builder()
        .label("Sign in to Hatbot")
        .css_classes(["title-1"])
        .build();

    let address = adw::EntryRow::builder().title("Address").build();
    address.set_input_purpose(gtk::InputPurpose::Url);
    address.set_text(prefill.unwrap_or(""));
    let password = adw::PasswordEntryRow::builder().title("Password").build();
    let code = adw::EntryRow::builder()
        .title("Code from your authenticator")
        .build();
    code.set_input_purpose(gtk::InputPurpose::Digits);
    code.set_max_length(6);
    let fields = adw::PreferencesGroup::new();
    fields.add(&address);
    fields.add(&password);
    fields.add(&code);

    let error = gtk::Label::builder()
        .wrap(true)
        .visible(false)
        .css_classes(["error"])
        .xalign(0.0)
        .build();
    let button = gtk::Button::builder()
        .label("Sign In")
        .css_classes(["pill", "suggested-action"])
        .halign(gtk::Align::Center)
        .build();

    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(18)
        .valign(gtk::Align::Center)
        .margin_top(24)
        .margin_bottom(24)
        .margin_start(12)
        .margin_end(12)
        .build();
    for w in [
        mark.upcast_ref::<gtk::Widget>(),
        title.upcast_ref(),
        fields.upcast_ref(),
        error.upcast_ref(),
        button.upcast_ref(),
    ] {
        column.append(w);
    }
    let clamp = adw::Clamp::builder()
        .maximum_size(420)
        .child(&column)
        .build();
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .child(&clamp)
        .build();
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::builder().show_title(false).build());
    view.set_content(Some(&scroll));

    // One per address for every try, so the brain's device cookie stays.
    let anonymous: Rc<std::cell::RefCell<Option<Api>>> = Rc::default();
    let on_signed_in = Rc::new(on_signed_in);
    let submit = {
        let (address, password, code, error, button) = (
            address.clone(),
            password.clone(),
            code.clone(),
            error.clone(),
            button.clone(),
        );
        move || {
            let server = match session::parse_server(&address.text()) {
                Ok(s) => s,
                Err(e) => {
                    error.set_label(&e.message);
                    error.set_visible(true);
                    return;
                }
            };
            let api = {
                let mut slot = anonymous.borrow_mut();
                match slot.as_ref() {
                    Some(a) if a.server() == server => a.clone(),
                    _ => slot.insert(Api::new(&server, None)).clone(),
                }
            };
            let (pw, otp) = (password.text().to_string(), code.text().to_string());
            button.set_sensitive(false);
            error.set_visible(false);
            let (error, button, code, on_signed_in) = (
                error.clone(),
                button.clone(),
                code.clone(),
                on_signed_in.clone(),
            );
            glib::spawn_future_local(async move {
                match session::login(&api, &pw, &otp, &session::device_name()).await {
                    Ok(token) => on_signed_in(server, token),
                    Err(e) => {
                        error.set_label(&e.message);
                        error.set_visible(true);
                        // A code works once: the next try needs a new one.
                        code.set_text("");
                        code.grab_focus();
                        button.set_sensitive(true);
                    }
                }
            });
        }
    };
    let submit = Rc::new(submit);
    for row in [
        address.upcast_ref::<adw::EntryRow>(),
        password.upcast_ref(),
        code.upcast_ref(),
    ] {
        let submit = submit.clone();
        row.connect_entry_activated(move |_| submit());
    }
    button.connect_clicked(move |_| submit());
    if prefill.is_some() {
        password.grab_focus();
    }
    view.upcast()
}
