// A stand-in brain on localhost: answers each request from a table, and remembers what came.
#![allow(dead_code)]
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub authorization: Option<String>,
    pub body: String,
}

#[derive(Clone)]
pub struct FakeBrain {
    pub url: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

/// "METHOD /path" → (status, JSON body).
pub async fn fake_brain(routes: &[(&str, u16, &str)]) -> FakeBrain {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let routes: Arc<HashMap<String, (u16, String)>> =
        Arc::new(routes.iter().map(|(k, s, b)| (k.to_string(), (*s, b.to_string()))).collect());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let routes = routes.clone();
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_string();
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        while buf.len() < i + 4 + len {
                            let n = sock.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        break (head, String::from_utf8_lossy(&buf[i + 4..]).to_string());
                    }
                };
                let mut first = head.lines().next().unwrap_or("").split(' ');
                let method = first.next().unwrap_or("").to_string();
                let full = first.next().unwrap_or("").to_string();
                let path = full.strip_prefix("/api/v1").unwrap_or(&full).to_string();
                let authorization = head
                    .lines()
                    .find_map(|l| l.to_lowercase().starts_with("authorization:").then(|| l[14..].trim().to_string()));
                log.lock().unwrap().push(Seen { method: method.clone(), path: path.clone(), authorization, body });
                let bare = path.split('?').next().unwrap_or("").to_string();
                let (status, reply) = routes
                    .get(&format!("{method} {path}"))
                    .or_else(|| routes.get(&format!("{method} {bare}")))
                    .cloned()
                    .unwrap_or((404, r#"{"error":"That's gone."}"#.into()));
                let res = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = sock.write_all(res.as_bytes()).await;
            });
        }
    });
    FakeBrain { url, seen }
}
