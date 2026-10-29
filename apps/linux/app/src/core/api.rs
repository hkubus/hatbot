// The brain's HTTP API, with the app's bearer token.
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;

pub const PREFIX: &str = "/api/v1";

#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    /// 0 when the brain couldn't be reached or answered something unreadable.
    pub status: u16,
    pub message: String,
    /// The answer's body, for errors that say more than a message (a memory conflict's newer copy).
    pub body: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { status: 0, message: message.into(), body: String::new() }
    }

    fn unreachable() -> Self {
        Self::new("Couldn't reach Hatbot.")
    }

    fn unreadable() -> Self {
        Self::new("Hatbot sent something this app doesn't understand.")
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status == 401
    }
}

pub type Result<T> = std::result::Result<T, ApiError>;

/// The brain's address from what was typed. Only https, but for a brain on this computer: the token
/// goes with every request.
pub fn server_url(input: &str) -> std::result::Result<String, String> {
    let mut s = input.trim().to_string();
    if s.is_empty() {
        return Err("Enter your Hatbot's address.".into());
    }
    if !s.contains("://") {
        s = format!("https://{s}");
    }
    while s.ends_with('/') {
        s.pop();
    }
    if let Some(stripped) = s.strip_suffix(PREFIX) {
        s = stripped.to_string();
    }
    let url = reqwest::Url::parse(&s).map_err(|_| "That isn't an address.".to_string())?;
    let host = url.host_str().ok_or("That isn't an address.")?.to_string();
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1");
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => {
            return Err(
                "Use your Hatbot's https address. Over http, your password and token would travel unencrypted.".into(),
            );
        }
    }
    let mut out = format!("{}://{}", url.scheme(), host);
    if let Some(port) = url.port() {
        out += &format!(":{port}");
    }
    out += url.path().trim_end_matches('/');
    Ok(out)
}

/// A query value, escaped: memory paths can hold spaces, "&" or "+".
pub fn query(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out += &format!("%{b:02X}");
        }
    }
    out
}

#[derive(Clone)]
pub struct Api {
    pub server: String,
    pub token: Option<String>,
    http: reqwest::Client,
}

impl std::fmt::Debug for Api {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Api").field("server", &self.server).finish()
    }
}

#[derive(Serialize)]
struct Empty {}

impl Api {
    pub fn new(server: &str, token: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("Hatbot for Linux/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("an HTTP client");
        Self { server: server.to_string(), token, http }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{PREFIX}{path}", self.server)
    }

    /// The stream's and the live view's sockets: wss for https, ws only for a brain on this computer.
    pub fn socket_url(&self, path: &str) -> String {
        let url = self.url(path);
        if let Some(rest) = url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            url
        }
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let mut req = self.http.request(method, self.url(path));
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        req
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<bytes::Bytes> {
        let res = req.send().await.map_err(|_| ApiError::unreachable())?;
        let status = res.status();
        let body = res.bytes().await.map_err(|_| ApiError::unreachable())?;
        if status.is_success() {
            return Ok(body);
        }
        Err(error_of(status, &body))
    }

    fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T> {
        let body: &[u8] = if body.is_empty() { b"null" } else { body };
        serde_json::from_slice(body).map_err(|_| ApiError::unreadable())
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        Self::decode(&self.send(self.request(Method::GET, path)).await?)
    }

    pub async fn bytes(&self, path: &str) -> Result<Vec<u8>> {
        Ok(self.send(self.request(Method::GET, path)).await?.to_vec())
    }

    pub async fn post<T: DeserializeOwned, B: Serialize + ?Sized>(&self, path: &str, body: &B) -> Result<T> {
        Self::decode(&self.send(self.request(Method::POST, path).json(body)).await?)
    }

    /// A POST with no body that answers nothing the app reads.
    pub async fn post_empty(&self, path: &str) -> Result<()> {
        self.send(self.request(Method::POST, path).json(&Empty {})).await.map(|_| ())
    }

    /// A POST whose answer the app doesn't read.
    pub async fn post_unit<B: Serialize + ?Sized>(&self, path: &str, body: &B) -> Result<()> {
        self.send(self.request(Method::POST, path).json(body)).await.map(|_| ())
    }

    pub async fn put<T: DeserializeOwned, B: Serialize + ?Sized>(&self, path: &str, body: &B) -> Result<T> {
        Self::decode(&self.send(self.request(Method::PUT, path).json(body)).await?)
    }

    pub async fn patch<T: DeserializeOwned, B: Serialize + ?Sized>(&self, path: &str, body: &B) -> Result<T> {
        Self::decode(&self.send(self.request(Method::PATCH, path).json(body)).await?)
    }

    pub async fn delete(&self, path: &str) -> Result<()> {
        self.send(self.request(Method::DELETE, path)).await.map(|_| ())
    }

    pub async fn upload<T: DeserializeOwned>(
        &self,
        path: &str,
        name: &str,
        media_type: &str,
        data: Vec<u8>,
    ) -> Result<T> {
        let part = reqwest::multipart::Part::bytes(data)
            .file_name(name.to_string())
            .mime_str(media_type)
            .map_err(|_| ApiError::new("That file's type isn't one Hatbot takes."))?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let req = self.request(Method::POST, path).timeout(Duration::from_secs(300)).multipart(form);
        Self::decode(&self.send(req).await?)
    }
}

fn error_of(status: StatusCode, body: &[u8]) -> ApiError {
    #[derive(serde::Deserialize)]
    struct Said {
        error: Option<String>,
    }
    let said = serde_json::from_slice::<Said>(body).ok().and_then(|s| s.error);
    ApiError {
        status: status.as_u16(),
        message: said.unwrap_or_else(|| format!("HTTP {}", status.as_u16())),
        body: String::from_utf8_lossy(body).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_https_unless_the_brain_is_on_this_computer() {
        assert_eq!(server_url("hat.example.com/").unwrap(), "https://hat.example.com");
        assert_eq!(server_url("https://hat.example.com/api/v1").unwrap(), "https://hat.example.com");
        assert_eq!(server_url("http://localhost:8787").unwrap(), "http://localhost:8787");
        assert!(server_url("http://hat.example.com").is_err());
        assert!(server_url("  ").is_err());
    }
}
