// JSON requests to the brain with the app's bearer token (PLAN.md §8), on libsoup and the GLib
// main loop.
use std::cell::RefCell;
use std::rc::Rc;

use gtk::glib;
use serde::Serialize;
use serde::de::DeserializeOwned;
use soup::prelude::*;

use crate::core::address::API_PREFIX;

#[derive(Debug, Clone)]
pub struct ApiError {
    /// 0 when the brain wasn't reached or sent something unreadable.
    pub status: u32,
    pub message: String,
    /// The answer's body, for errors that say more than a message.
    pub body: Vec<u8>,
}

impl ApiError {
    fn local(message: &str) -> ApiError {
        ApiError {
            status: 0,
            message: message.into(),
            body: vec![],
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Result<T> = std::result::Result<T, ApiError>;

/// An empty or ignored response body.
#[derive(serde::Deserialize, Serialize, Debug)]
pub struct Empty {}

#[derive(Clone)]
pub struct Api(Rc<Inner>);

struct Inner {
    /// The server's root, like https://hatbot.example.com.
    server: String,
    token: Option<String>,
    session: soup::Session,
    /// For the calls that wait on the model or try every part.
    slow: soup::Session,
    on_unauthorized: RefCell<Option<Box<dyn Fn()>>>,
}

/// The most an attachment may be (MAX_ATTACHMENT_BYTES in apps/brain/src/attachments.ts).
pub const MAX_UPLOAD: u64 = 25 * 1024 * 1024;

impl Api {
    pub fn new(server: &str, token: Option<String>) -> Api {
        let session = soup::Session::new();
        session.set_timeout(30);
        session.add_feature(&soup::CookieJar::new());
        let slow = soup::Session::new();
        slow.set_timeout(130);
        for s in [&session, &slow] {
            s.set_user_agent(concat!("Hatbot-Linux/", env!("CARGO_PKG_VERSION")));
        }
        Api(Rc::new(Inner {
            server: server.trim_end_matches('/').to_string(),
            token,
            session,
            slow,
            on_unauthorized: RefCell::new(None),
        }))
    }

    pub fn server(&self) -> &str {
        &self.0.server
    }

    pub fn token(&self) -> Option<&str> {
        self.0.token.as_deref()
    }

    /// Called once the brain no longer takes the token.
    pub fn on_unauthorized(&self, f: impl Fn() + 'static) {
        self.0.on_unauthorized.replace(Some(Box::new(f)));
    }

    pub fn unauthorized(&self) {
        if let Some(f) = self.0.on_unauthorized.borrow().as_ref() {
            f();
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{API_PREFIX}{path}", self.0.server)
    }

    /// The WebSocket address for `path`: wss for an https brain.
    pub fn ws_url(&self, path: &str) -> String {
        let url = self.url(path);
        match url.split_once("://") {
            Some(("https", rest)) => format!("wss://{rest}"),
            Some((_, rest)) => format!("ws://{rest}"),
            None => url,
        }
    }

    pub fn message(&self, method: &str, url: &str) -> soup::Message {
        let msg = soup::Message::new(method, url).expect("a valid URL");
        if let (Some(token), Some(headers)) = (&self.0.token, msg.request_headers()) {
            headers.append("Authorization", &format!("Bearer {token}"));
        }
        msg
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.call(path, "GET", None::<&Empty>, false).await
    }

    pub async fn post<T: DeserializeOwned, B: Serialize>(&self, path: &str, body: &B) -> Result<T> {
        self.call(path, "POST", Some(body), false).await
    }

    /// A POST whose answer doesn't matter.
    pub async fn post_empty(&self, path: &str) -> Result<()> {
        let _: serde_json::Value = self.call(path, "POST", Some(&Empty {}), false).await?;
        Ok(())
    }

    /// For the calls that wait on the model or try every part, up to about two minutes.
    pub async fn post_slow<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        self.call(path, "POST", Some(body), true).await
    }

    pub async fn put<T: DeserializeOwned, B: Serialize>(&self, path: &str, body: &B) -> Result<T> {
        self.call(path, "PUT", Some(body), false).await
    }

    pub async fn patch<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        self.call(path, "PATCH", Some(body), false).await
    }

    /// A PATCH that reads a page again, which can take as long as `post_slow`.
    pub async fn patch_slow<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        self.call(path, "PATCH", Some(body), true).await
    }

    pub async fn delete(&self, path: &str) -> Result<()> {
        let _: serde_json::Value = self.call(path, "DELETE", None::<&Empty>, false).await?;
        Ok(())
    }

    /// Raw bytes, for screenshots and attachments.
    pub async fn bytes(&self, path: &str) -> Result<glib::Bytes> {
        let msg = self.message("GET", &self.url(path));
        self.send(path, &msg, false).await
    }

    /// A file as multipart field "file", as POST /attachments reads it; the answer is JSON.
    pub async fn upload<T: DeserializeOwned>(
        &self,
        path: &str,
        name: &str,
        media_type: &str,
        data: &[u8],
    ) -> Result<T> {
        let boundary = format!("hatbot-{}", glib::uuid_string_random());
        let safe = name.replace(['"', '\r', '\n'], "_");
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe}\"\r\nContent-Type: {media_type}\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let msg = self.message("POST", &self.url(path));
        msg.set_request_body_from_bytes(
            Some(&format!("multipart/form-data; boundary={boundary}")),
            Some(&glib::Bytes::from_owned(body)),
        );
        let out = self.send(path, &msg, true).await?;
        decode(&out)
    }

    async fn call<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        method: &str,
        body: Option<&B>,
        slow: bool,
    ) -> Result<T> {
        let msg = self.message(method, &self.url(path));
        if let Some(body) = body {
            let json =
                serde_json::to_vec(body).map_err(|_| ApiError::local("Couldn't send that."))?;
            msg.set_request_body_from_bytes(
                Some("application/json"),
                Some(&glib::Bytes::from_owned(json)),
            );
        }
        let out = self.send(path, &msg, slow).await?;
        // 204 No Content: whatever an empty answer decodes to.
        if out.is_empty() {
            return serde_json::from_slice(b"null")
                .or_else(|_| serde_json::from_slice(b"{}"))
                .map_err(|_| ApiError::local(UNREADABLE));
        }
        decode(&out)
    }

    async fn send(&self, path: &str, msg: &soup::Message, slow: bool) -> Result<glib::Bytes> {
        let session = if slow { &self.0.slow } else { &self.0.session };
        let out = session
            .send_and_read_future(msg, glib::Priority::DEFAULT)
            .await
            .map_err(|_| ApiError::local("Couldn't reach Hatbot."))?;
        let status = msg.status().into_glib() as u32;
        if (200..300).contains(&status) {
            return Ok(out);
        }
        if status == 401 && !path.starts_with("/auth/") {
            self.unauthorized();
        }
        let message = serde_json::from_slice::<serde_json::Value>(&out)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        Err(ApiError {
            status,
            message,
            body: out.to_vec(),
        })
    }
}

const UNREADABLE: &str = "Hatbot sent something this app doesn't understand.";

fn decode<T: DeserializeOwned>(data: &[u8]) -> Result<T> {
    serde_json::from_slice(data).map_err(|_| ApiError::local(UNREADABLE))
}

/// A query value, escaped: memory paths can hold spaces, "&" or "+".
pub fn query(value: &str) -> String {
    glib::Uri::escape_string(value, None, false).to_string()
}

use glib::translate::IntoGlib;
