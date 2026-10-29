// Signing in: the brain's address, then a password and an authenticator code for a device token.
use serde::Serialize;

use super::api::{Api, ApiError, Result, server_url};
use super::models::{LoginResponse, Me};

#[derive(Serialize)]
struct Login<'a> {
    password: &'a str,
    totp: &'a str,
    client: &'static str,
    device: &'a str,
}

/// The brain's address as kept, and the token it gave this device.
pub async fn sign_in(address: &str, password: &str, code: &str, device: &str) -> Result<(String, String)> {
    let server = server_url(address).map_err(ApiError::new)?;
    let anonymous = Api::new(&server, None);
    let me: Me = anonymous.get("/auth/me").await?;
    if !me.setup_done {
        return Err(ApiError::new("Finish setting up Hatbot in the web app first."));
    }
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    let res: LoginResponse =
        anonymous.post("/auth/login", &Login { password, totp: &code, client: "app", device }).await?;
    let token = res
        .token
        .ok_or_else(|| ApiError::new("This Hatbot is too old for the app. Update it from Settings on the web."))?;
    Ok((server, token))
}

/// This computer's name, for the device list.
pub fn device_name() -> String {
    let host = std::fs::read_to_string("/etc/hostname").unwrap_or_default();
    let host = host.trim();
    if host.is_empty() { "Linux".into() } else { format!("{host} (Linux)") }
}
