// Mirrors packages/shared/src/computer.ts by hand. Requests and results a newer brain adds decode
// as `Unknown` rather than failing the socket.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const COMPUTER_PROTOCOL: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol: u32,
    pub machine_id: String,
    pub name: String,
    pub version: String,
    pub compositor: String,
    pub enabled: bool,
    pub features: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Screen {
    pub output: String,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub locked: bool,
    pub owner_active: bool,
    pub paused: bool,
    pub screen: Option<Screen>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub id: i64,
    pub title: String,
    pub app_id: String,
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Status,
    Claim { #[serde(rename = "taskId")] task_id: String },
    Release { #[serde(rename = "taskId")] task_id: String },
    Screenshot,
    Zoom { x: f64, y: f64, width: f64, height: f64 },
    Action { name: String, input: Map<String, Value> },
    Windows,
    FocusWindow { id: i64 },
    Inspect { #[serde(default)] x: Option<f64>, #[serde(default)] y: Option<f64> },
    Exec { command: String, #[serde(rename = "timeoutMs")] timeout_ms: u64 },
    PutFile { name: String, data: String, #[serde(default)] path: Option<String> },
    GetFile { path: String },
    Live { on: bool },
    LiveInput { input: Value },
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Owner,
    Locked,
    Paused,
    Disabled,
    Hidden,
    Busy,
    Failed,
}

/// One message on the socket, either way.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Message {
    Hello(Hello),
    Req { id: u64, req: Request },
    Res {
        id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        res: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<ErrorCode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Status { status: Status },
    #[serde(other)]
    Unknown,
}
