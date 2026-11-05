//! Commands from the brain, run as the owner with `sh -c`, or PowerShell on Windows. Never as root or
//! an administrator: the brain refuses a command that would raise itself, and so does this.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::protocol::ShellResult;

const MAX_OUTPUT: usize = 30_000;
const MAX_TIMEOUT: Duration = Duration::from_secs(600);
const ROOT: &[&str] = &["sudo", "doas", "pkexec", "su", "run0", "sudoedit", "runas", "gsudo"];

/// Whether a command calls something that runs as root, as a word anywhere in it (after a pipe, in
/// a subshell, by path).
pub fn raises(command: &str) -> bool {
    command
        .split(|c: char| c.is_whitespace() || ";&|()`$<>{}'\"".contains(c))
        .map(|w| w.rsplit(['/', '\\']).next().unwrap_or(w).to_lowercase())
        .map(|w| w.strip_suffix(".exe").map(str::to_owned).unwrap_or(w))
        .any(|w| ROOT.contains(&w.as_str()))
}

/// Long output keeps its start and end, where errors and results usually are.
pub fn clip(out: &str) -> String {
    let chars: Vec<char> = out.chars().collect();
    if chars.len() <= MAX_OUTPUT {
        return out.to_owned();
    }
    let half = MAX_OUTPUT / 2;
    format!(
        "{}\n… {} characters left out …\n{}",
        chars[..half].iter().collect::<String>(),
        chars.len() - MAX_OUTPUT,
        chars[chars.len() - half..].iter().collect::<String>()
    )
}

pub async fn run(command: &str, timeout_ms: u64) -> Result<ShellResult, String> {
    if raises(command) {
        return Err("Hatbot doesn't run commands as root on this computer.".into());
    }
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|_| "/".into());
    let mut child = shell(command)
        .current_dir(&home)
        .env_remove("HATBOT_DEVICE_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Couldn't start the shell: {e}."))?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let limit = Duration::from_millis(timeout_ms.max(1000)).min(MAX_TIMEOUT);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let waited = tokio::time::timeout(limit, async {
        let (_, _, status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
        status
    })
    .await;
    let (exit_code, timed_out) = match waited {
        Ok(Ok(status)) => (status.code().unwrap_or(-1), false),
        Ok(Err(e)) => return Err(format!("The command failed: {e}.")),
        Err(_) => {
            if let Some(pid) = child.id() {
                kill_tree(pid).await;
            }
            let _ = child.kill().await;
            (-1, true)
        }
    };
    let out = String::from_utf8_lossy(&out);
    let err = String::from_utf8_lossy(&err);
    let output = [out.trim_end().to_owned(), {
        let e = err.trim_end();
        if e.is_empty() { String::new() } else { format!("[stderr]\n{e}") }
    }]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    Ok(ShellResult { exit_code, output: clip(&output), timed_out })
}

#[cfg(unix)]
fn shell(command: &str) -> Command {
    let mut c = Command::new("sh");
    // Its own process group, so a timeout kills what it started too.
    c.arg("-c").arg(command).process_group(0);
    c
}

#[cfg(unix)]
async fn kill_tree(pid: u32) {
    let _ = rustix::process::kill_process_group(
        rustix::process::Pid::from_raw(pid as i32).expect("a child's pid"),
        rustix::process::Signal::KILL,
    );
}

/// PowerShell's own quoting of a `-Command` argument mangles quotes; an encoded one arrives as written.
#[cfg(windows)]
fn shell(command: &str) -> Command {
    use base64::Engine;
    let script = format!(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n{command}\n$ok = $?\nif (-not $ok) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }}; exit 1 }}"
    );
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut c = Command::new("powershell.exe");
    c.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
        .arg(base64::engine::general_purpose::STANDARD.encode(utf16))
        .creation_flags(NO_WINDOW);
    c
}

#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
async fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_anything_that_runs_as_root() {
        for c in [
            "sudo pacman -Syu",
            "ls; sudo rm -rf /",
            "echo x | /usr/bin/sudo tee /etc/x",
            "$(doas id)",
            "pkexec bash",
            "su -c id",
            "run0 id",
            "Start-Process pwsh -Verb RunAs",
            r"C:\Tools\gsudo.exe whoami",
        ] {
            assert!(raises(c), "{c}");
        }
        for c in ["ls -la", "echo sudoku", "cat ~/subject.txt"] {
            assert!(!raises(c), "{c}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_as_the_owner_and_stops_at_the_timeout() {
        let r = run("echo hi; echo oops >&2; exit 3", 5000).await.unwrap();
        assert_eq!(r.exit_code, 3);
        assert_eq!(r.output, "hi\n[stderr]\noops");
        let r = run("sleep 5", 1000).await.unwrap();
        assert!(r.timed_out);
        assert!(run("sudo id", 1000).await.is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn runs_in_powershell_and_stops_at_the_timeout() {
        let r = run("Write-Output 'hi \"there\"'; exit 3", 20_000).await.unwrap();
        assert_eq!(r.exit_code, 3);
        assert_eq!(r.output, "hi \"there\"");
        let r = run("Start-Sleep -Seconds 5", 1000).await.unwrap();
        assert!(r.timed_out);
    }
}
