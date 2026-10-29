// One running copy: `hatbot` run again asks the running one to open its window.
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use tokio::io::AsyncReadExt;

use super::inbox::{self, Outside};

fn path() -> PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    dir.join("hatbot.sock")
}

/// Tells a running copy to open its window. False when none runs.
pub fn ask_running(open: bool) -> bool {
    match UnixStream::connect(path()) {
        Ok(mut s) => {
            if open {
                let _ = s.write_all(b"open\n");
            }
            true
        }
        Err(_) => false,
    }
}

/// Listens for later launches. A socket left by a copy that crashed is taken over.
pub fn listen() -> std::io::Result<std::os::unix::net::UnixListener> {
    let p = path();
    let _ = std::fs::remove_file(&p);
    let l = std::os::unix::net::UnixListener::bind(&p)?;
    l.set_nonblocking(true)?;
    Ok(l)
}

pub async fn serve(listener: std::os::unix::net::UnixListener) {
    let Ok(l) = tokio::net::UnixListener::from_std(listener) else { return };
    while let Ok((mut s, _)) = l.accept().await {
        let mut buf = [0u8; 16];
        if let Ok(n) = s.read(&mut buf).await
            && buf[..n].starts_with(b"open")
        {
            inbox::send(Outside::Open);
        }
    }
}
