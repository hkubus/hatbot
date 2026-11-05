//! niri's IPC on $NIRI_SOCKET, as raw JSON: one request line, one reply line,
//! `{"Ok": {...}}` or `{"Err": "..."}`. (The niri-ipc crate is GPL.)

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::computer::{Rect, Result, Window};

pub struct Niri {
    socket: PathBuf,
}

#[derive(Debug, Deserialize)]
pub struct LogicalOutput {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

#[derive(Debug, Deserialize)]
pub struct NiriOutput {
    pub name: String,
    pub logical: Option<LogicalOutput>,
}

#[derive(Debug, Deserialize)]
struct NiriWindow {
    id: u64,
    title: Option<String>,
    app_id: Option<String>,
    pid: Option<i32>,
    workspace_id: Option<u64>,
    #[serde(default)]
    is_focused: bool,
    #[serde(default)]
    layout: Option<Layout>,
}

#[derive(Debug, Deserialize)]
struct Layout {
    #[serde(default)]
    tile_pos_in_workspace_view: Option<(f64, f64)>,
    #[serde(default)]
    window_offset_in_tile: Option<(f64, f64)>,
    window_size: Option<(i32, i32)>,
}

#[derive(Debug, Deserialize)]
struct Workspace {
    id: u64,
    output: Option<String>,
    #[serde(default)]
    is_active: bool,
}

#[derive(Debug, Deserialize)]
struct Layouts {
    current_idx: usize,
}

impl Niri {
    pub fn from_env() -> Option<Self> {
        std::env::var_os("NIRI_SOCKET").map(|s| Self { socket: s.into() })
    }

    async fn ask(&self, req: Value) -> Result<Value> {
        let fail = |e: std::io::Error| format!("niri didn't answer: {e}.");
        let mut s = UnixStream::connect(&self.socket).await.map_err(fail)?;
        s.write_all(format!("{req}\n").as_bytes()).await.map_err(fail)?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).await.map_err(fail)?;
        let mut reply: Value = serde_json::from_str(&line).map_err(|_| "niri's reply couldn't be read.".to_string())?;
        if let Some(e) = reply.get("Err").and_then(Value::as_str) {
            return Err(format!("niri: {e}"));
        }
        Ok(reply.get_mut("Ok").map(Value::take).unwrap_or(Value::Null))
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, what: &str) -> Result<T> {
        let mut v = self.ask(json!(what)).await?;
        serde_json::from_value(v.get_mut(what).map(Value::take).unwrap_or(Value::Null))
            .map_err(|e| format!("niri's {what} couldn't be read: {e}."))
    }

    pub async fn focused_output(&self) -> Result<Option<NiriOutput>> {
        self.get("FocusedOutput").await
    }

    pub async fn layout(&self) -> Result<usize> {
        Ok(self.get::<Layouts>("KeyboardLayouts").await?.current_idx)
    }

    pub async fn focus_window(&self, id: u64) -> Result<()> {
        self.ask(json!({"Action": {"FocusWindow": {"id": id}}})).await.map(drop)
    }

    /// Every window, placed on `output` (logical pixels from its top-left) when it's showing there.
    pub async fn windows(&self, output: &str) -> Result<Vec<Window>> {
        let workspaces: Vec<Workspace> = self.get("Workspaces").await?;
        let windows: Vec<NiriWindow> = self.get("Windows").await?;
        Ok(windows.into_iter().map(|w| place(w, &workspaces, output)).collect())
    }
}

fn place(w: NiriWindow, workspaces: &[Workspace], output: &str) -> Window {
    let showing = workspaces
        .iter()
        .any(|ws| Some(ws.id) == w.workspace_id && ws.is_active && ws.output.as_deref() == Some(output));
    let rect = w.layout.as_ref().filter(|_| showing).and_then(|l| {
        let (tx, ty) = l.tile_pos_in_workspace_view?;
        let (ox, oy) = l.window_offset_in_tile.unwrap_or_default();
        let (ww, wh) = l.window_size?;
        Some(Rect { x: tx + ox, y: ty + oy, width: ww as f64, height: wh as f64 })
    });
    Window {
        id: w.id,
        title: w.title.unwrap_or_default(),
        app_id: w.app_id.unwrap_or_default(),
        focused: w.is_focused,
        pid: w.pid,
        rect,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_only_windows_showing_on_the_tasks_monitor() {
        let workspaces: Vec<Workspace> = serde_json::from_value(json!([
            {"id": 1, "idx": 1, "output": "DP-1", "is_active": true, "is_focused": true, "is_urgent": false},
            {"id": 2, "idx": 2, "output": "DP-1", "is_active": false},
            {"id": 3, "idx": 1, "output": "HDMI-A-1", "is_active": true},
        ]))
        .unwrap();
        let window = |id: u64, ws: u64| -> NiriWindow {
            serde_json::from_value(json!({
                "id": id, "title": "t", "app_id": "a", "pid": 7, "workspace_id": ws,
                "is_focused": id == 1, "is_floating": false, "is_urgent": false, "new_field": 1,
                "layout": {"pos_in_scrolling_layout": [1, 1], "tile_size": [810.0, 610.0],
                    "window_size": [800, 600], "tile_pos_in_workspace_view": [16.0, 40.0],
                    "window_offset_in_tile": [5.0, 5.0]}
            }))
            .unwrap()
        };
        let on = place(window(1, 1), &workspaces, "DP-1");
        assert_eq!(on.rect, Some(Rect { x: 21.0, y: 45.0, width: 800.0, height: 600.0 }));
        assert!(on.focused);
        assert_eq!(place(window(2, 2), &workspaces, "DP-1").rect, None);
        assert_eq!(place(window(3, 3), &workspaces, "DP-1").rect, None);
    }
}
