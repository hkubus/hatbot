// Signing in trades password + TOTP for a token named after the computer (POST /auth/login with
// client "app"); signing out ends that token on the brain.
use serde::Serialize;

use crate::core::address::{is_plain_http, server_url};
use crate::core::models::{LoginResponse, Me};
use crate::net::api::{Api, ApiError, Result};

fn refuse(message: &str) -> ApiError {
    ApiError {
        status: 0,
        message: message.into(),
        body: vec![],
    }
}

/// The address to sign in to, as typed: https only.
pub fn parse_server(input: &str) -> Result<String> {
    server_url(input).ok_or_else(|| {
        refuse(if is_plain_http(input) {
            "Use your Hatbot's https address. Over http, your password and token would travel unencrypted."
        } else {
            "Enter your Hatbot's address."
        })
    })
}

/// A token for this computer from `anonymous`'s brain. The same `anonymous` for every try keeps the
/// brain's device cookie, so other people's wrong guesses don't lock you out.
pub async fn login(anonymous: &Api, password: &str, code: &str, device: &str) -> Result<String> {
    let me: Me = anonymous.get("/auth/me").await?;
    if !me.setup_done {
        return Err(refuse("Finish setting up Hatbot in the web app first."));
    }
    #[derive(Serialize)]
    struct Body<'a> {
        password: &'a str,
        totp: &'a str,
        client: &'a str,
        device: &'a str,
    }
    let body = Body {
        password,
        totp: code.trim(),
        client: "app",
        device,
    };
    let res: LoginResponse = anonymous.post("/auth/login", &body).await?;
    res.token.ok_or_else(|| {
        refuse("This Hatbot is too old for the app. Update it from Settings on the web.")
    })
}

/// What the token is called in Settings → API tokens: the computer, the app and the day.
pub fn device_name() -> String {
    let host = gtk::glib::host_name();
    let day = gtk::glib::DateTime::now_local()
        .and_then(|d| d.format("%-d %b %Y"))
        .map(|d| d.to_string())
        .unwrap_or_default();
    format!("{host} (Hatbot Linux) {day}")
        .trim()
        .chars()
        .take(100)
        .collect()
}

/// Ends the token on the brain too, when it's reachable.
pub async fn logout(api: &Api) {
    let _ = api.post_empty("/auth/logout").await;
}
