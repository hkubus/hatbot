//! The protocol between the brain and this agent, mirrored by hand from
//! `packages/shared/src/computer.ts` (and the parts of `desktop.ts` it uses). Text frames are JSON
//! [`Message`]s, binary frames live JPEG frames. Anything unknown (a message, an op, an action, an
//! enum value) reads as an `Unknown` variant rather than failing, so a newer brain doesn't break us.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PROTOCOL: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Message {
    Hello(Hello),
    Req {
        id: u64,
        req: Request,
    },
    Res(Response),
    Status {
        status: ComputerStatus,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// The focused monitor, chosen when a task takes the screen and kept for it. In logical pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerScreen {
    pub output: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatus {
    pub enabled: bool,
    pub locked: bool,
    pub owner_active: bool,
    pub paused: bool,
    pub screen: Option<ComputerScreen>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWindow {
    pub id: u64,
    pub title: String,
    pub app_id: String,
    pub focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

/// What the brain asks. Coordinates are in the screenshot's pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Status,
    #[serde(rename_all = "camelCase")]
    Claim {
        task_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Release {
        task_id: String,
    },
    Screenshot,
    Zoom {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Action {
        name: ActionName,
        #[serde(default)]
        input: Map<String, Value>,
    },
    Windows,
    FocusWindow {
        id: u64,
    },
    Inspect {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Exec {
        command: String,
        timeout_ms: u64,
    },
    PutFile {
        name: String,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    GetFile {
        path: String,
    },
    Live {
        on: bool,
    },
    LiveInput {
        input: LiveInput,
    },
    Pause {
        paused: bool,
    },
    Disable,
    #[serde(other)]
    Unknown,
}

/// The computer toolset's members, less screenshot and zoom (their own requests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionName {
    Key,
    HoldKey,
    Type,
    CursorPosition,
    MouseMove,
    LeftMouseDown,
    LeftMouseUp,
    LeftClick,
    LeftClickDrag,
    RightClick,
    MiddleClick,
    DoubleClick,
    TripleClick,
    Scroll,
    Wait,
    #[serde(other)]
    Unknown,
}

/// Input from the owner while they have control from Live, in the live frames' pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum LiveInput {
    Move {
        x: f64,
        y: f64,
    },
    Button {
        button: u8,
        down: bool,
        x: f64,
        y: f64,
    },
    Wheel {
        dy: f64,
        dx: f64,
        x: f64,
        y: f64,
    },
    Key {
        key: String,
        down: bool,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ActionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub exit_code: i32,
    pub output: String,
    pub timed_out: bool,
}

/// An element from AT-SPI, in the shape desktop-agent gives the brain for a page's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentElement {
    pub tag: String,
    pub role: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub label: String,
    pub in_form: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toggle: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buttons_after: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ComputerResult {
    Status {
        status: ComputerStatus,
    },
    Claim {
        screen: ComputerScreen,
    },
    Release,
    Screenshot {
        data: String,
        width: u32,
        height: u32,
    },
    Zoom {
        data: String,
        width: u32,
        height: u32,
    },
    Action {
        result: ActionResult,
    },
    Windows {
        windows: Vec<ComputerWindow>,
    },
    FocusWindow,
    Inspect {
        element: Option<AgentElement>,
    },
    Exec {
        result: ShellResult,
    },
    PutFile {
        path: String,
    },
    GetFile {
        name: String,
        data: String,
    },
    Live,
    LiveInput,
    Pause,
    Disable,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Owner,
    Locked,
    Paused,
    Disabled,
    Hidden,
    Busy,
    Failed,
    #[serde(other)]
    Unknown,
}

/// `{t: "res", id, ok: true, res}` or `{t: "res", id, ok: false, code, error}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub res: Option<ComputerResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(id: u64, res: ComputerResult) -> Self {
        Self { id, ok: true, res: Some(res), code: None, error: None }
    }

    pub fn err(id: u64, code: ErrorCode, error: impl Into<String>) -> Self {
        Self { id, ok: false, res: None, code: Some(code), error: Some(error.into()) }
    }
}

/// A text frame from the brain. A request we can't read still gets an answer when its id can be
/// found; anything else unreadable is dropped.
pub fn read(text: &str) -> Result<Message, Option<u64>> {
    serde_json::from_str(text).map_err(|_| {
        serde_json::from_str::<Value>(text)
            .ok()
            .filter(|v| v.get("t").and_then(Value::as_str) == Some("req"))
            .and_then(|v| v.get("id").and_then(Value::as_u64))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn req(v: Value) -> Result<Message, Option<u64>> {
        read(&v.to_string())
    }

    #[test]
    fn reads_the_brains_requests() {
        let m = req(json!({"t": "req", "id": 3, "req": {"op": "claim", "taskId": "t1"}}));
        assert_eq!(m, Ok(Message::Req { id: 3, req: Request::Claim { task_id: "t1".into() } }));
        let m = req(json!({"t": "req", "id": 4, "req": {"op": "action", "name": "left_click",
            "input": {"coordinate": [1, 2]}}}));
        assert!(matches!(
            m,
            Ok(Message::Req { req: Request::Action { name: ActionName::LeftClick, .. }, .. })
        ));
        let m = req(json!({"t": "req", "id": 5, "req": {"op": "live_input",
            "input": {"t": "button", "button": 1, "down": true, "x": 3, "y": 4}}}));
        assert!(matches!(
            m,
            Ok(Message::Req { req: Request::LiveInput { input: LiveInput::Button { .. } }, .. })
        ));
    }

    #[test]
    fn tolerates_what_a_newer_brain_sends() {
        assert_eq!(req(json!({"t": "bye", "why": "x"})), Ok(Message::Unknown));
        assert_eq!(
            req(json!({"t": "req", "id": 6, "req": {"op": "teleport", "where": "moon"}})),
            Ok(Message::Req { id: 6, req: Request::Unknown })
        );
        let m = req(
            json!({"t": "req", "id": 7, "req": {"op": "action", "name": "juggle", "input": {}}}),
        );
        assert!(matches!(
            m,
            Ok(Message::Req { req: Request::Action { name: ActionName::Unknown, .. }, .. })
        ));
        let m =
            req(json!({"t": "req", "id": 8, "req": {"op": "live_input", "input": {"t": "pinch"}}}));
        assert!(matches!(
            m,
            Ok(Message::Req { req: Request::LiveInput { input: LiveInput::Unknown }, .. })
        ));
        // A known op it can't read still gets an answer, by its id.
        assert_eq!(
            req(json!({"t": "req", "id": 9, "req": {"op": "zoom", "x": "a"}})),
            Err(Some(9))
        );
        let e: ErrorCode = serde_json::from_value(json!("sleepy")).unwrap();
        assert_eq!(e, ErrorCode::Unknown);
    }

    #[test]
    fn answers_in_the_brains_shape() {
        let ok = Message::Res(Response::ok(
            1,
            ComputerResult::Screenshot { data: "x".into(), width: 2, height: 3 },
        ));
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({"t": "res", "id": 1, "ok": true, "res": {"op": "screenshot", "data": "x", "width": 2, "height": 3}})
        );
        let err =
            Message::Res(Response::err(2, ErrorCode::Owner, "The owner is using the computer."));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({"t": "res", "id": 2, "ok": false, "code": "owner", "error": "The owner is using the computer."})
        );
        let hello = Message::Hello(Hello {
            protocol: 1,
            machine_id: "m".into(),
            name: "n".into(),
            version: "v".into(),
            compositor: "niri".into(),
            enabled: true,
            features: vec![],
        });
        let v = serde_json::to_value(&hello).unwrap();
        assert_eq!(v["t"], "hello");
        assert_eq!(v["machineId"], "m");
        assert_eq!(serde_json::from_value::<Message>(v).unwrap(), hello);
        let status =
            Message::Status { status: ComputerStatus { owner_active: true, ..Default::default() } };
        assert_eq!(serde_json::to_value(&status).unwrap()["status"]["ownerActive"], true);
    }
}
