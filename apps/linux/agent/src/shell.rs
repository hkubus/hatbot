//! Commands from the brain, run as the owner with `sh -c`. Never as root: the brain refuses a command
//! that would raise itself, and so does this.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::protocol::ShellResult;

const MAX_OUTPUT: usize = 30_000;
const MAX_TIMEOUT: Duration = Duration::from_secs(600);
const ROOT: &[&str] = &["sudo", "doas", "pkexec", "su", "run0", "sudoedit"];

/// Whether a command calls something that runs as root, as a word anywhere in it (after a pipe, in
/// a subshell, by path).
pub fn raises(command: &str) -> bool {
    command
        .split(|c: char| c.is_whitespace() || ";&|()`$<>{}'\"".contains(c))
        .map(|w| w.rsplit('/').next().unwrap_or(w))
        .any(|w| ROOT.contains(&w))
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
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(&home)
        .env_remove("HATBOT_DEVICE_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own process group, so a timeout kills what it started too.
        .process_group(0)
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
                let _ = rustix::process::kill_process_group(
                    rustix::process::Pid::from_raw(pid as i32).expect("a child's pid"),
                    rustix::process::Signal::KILL,
                );
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
        ] {
            assert!(raises(c), "{c}");
        }
        for c in ["ls -la", "echo sudoku", "cat ~/subject.txt"] {
            assert!(!raises(c), "{c}");
        }
    }

    #[tokio::test]
    async fn runs_as_the_owner_and_stops_at_the_timeout() {
        let r = run("echo hi; echo oops >&2; exit 3", 5000).await.unwrap();
        assert_eq!(r.exit_code, 3);
        assert_eq!(r.output, "hi\n[stderr]\noops");
        let r = run("sleep 5", 1000).await.unwrap();
        assert!(r.timed_out);
        assert!(run("sudo id", 1000).await.is_err());
    }
}
