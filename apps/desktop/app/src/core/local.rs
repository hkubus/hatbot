// Hatbot's brain on this computer, for running it without a server: Bun and the brain at this app's own
// commit under ~/.local/share/hatbot, run by a systemd user service that starts at login; on Windows
// under %LOCALAPPDATA%\Hatbot, run by `hatbot --brain`, which starts at sign-in.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

pub const COMMIT: &str = env!("HATBOT_COMMIT");
const BUN_VERSION: &str = "1.4.2";
/// From the release's SHASUMS256.txt.
const BUN_BUILDS: [(&str, &str); 6] = [
    ("bun-linux-x64", "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"),
    ("bun-linux-x64-baseline", "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"),
    ("bun-linux-aarch64", "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"),
    ("bun-windows-x64", "ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405"),
    ("bun-windows-x64-baseline", "78c221c2376f79731ccf4e4af0b3bb46d81fefa3296c5abee09ad8a1b21e68c6"),
    ("bun-windows-aarch64", "a7a16b876a305fd1029c66dbd27007b4f6112ae896532f675878731a21e50cfd"),
];
/// Forgejo sometimes hangs, so the GitHub mirror goes first.
const SOURCES: [&str; 2] = ["https://github.com/hkubus/hatbot/archive", "https://git.gaycats.ovh/kubus/hatbot/archive"];
const LOOPBACK: &str = "127.0.0.1";

pub struct Paths {
    pub root: PathBuf,
    pub bun: PathBuf,
    pub data: PathBuf,
    pub env: PathBuf,
}

#[cfg(not(windows))]
fn xdg(var: &str, fallback: &str) -> PathBuf {
    let home = || PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(fallback))
}

pub fn paths() -> Paths {
    #[cfg(windows)]
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("Hatbot");
    #[cfg(not(windows))]
    let root = xdg("XDG_DATA_HOME", ".local/share").join("hatbot");
    Paths {
        bun: root.join("bun").join(format!("bun{}", std::env::consts::EXE_SUFFIX)),
        data: root.join("data"),
        env: super::vault::config_dir().join("brain.env"),
        root,
    }
}

pub fn parse_env(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

pub fn format_env(env: &BTreeMap<String, String>) -> String {
    env.iter().map(|(k, v)| format!("{k}={v}\n")).collect()
}

fn read_env(p: &Paths) -> BTreeMap<String, String> {
    std::fs::read_to_string(&p.env).map(|t| parse_env(&t)).unwrap_or_default()
}

fn write_env(p: &Paths, env: &BTreeMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(p.env.parent().unwrap_or(Path::new("/"))).map_err(|e| e.to_string())?;
    std::fs::write(&p.env, format_env(env)).map_err(|e| format!("Couldn't save {}: {e}", p.env.display()))
}

/// What the brain is started with; a port and an address already chosen are kept.
pub fn brain_env(old: &BTreeMap<String, String>, data: &Path, port: u16) -> BTreeMap<String, String> {
    let mut env = old.clone();
    let data = data.display().to_string();
    env.insert("HATBOT_LOCAL".into(), "1".into());
    env.insert("HATBOT_PORT".into(), port.to_string());
    env.entry("HATBOT_HOST".into()).or_insert_with(|| LOOPBACK.into());
    env.entry("HATBOT_PUBLIC_URL".into()).or_insert_with(|| format!("http://{LOOPBACK}:{port}"));
    env.insert("HATBOT_UPDATE_DIR".into(), Path::new(&data).join("update").display().to_string());
    env.insert("HATBOT_DATA_DIR".into(), data);
    env
}

/// Listening on every address, with the web app's address on the network, or back to this computer only.
pub fn lan_env(env: &BTreeMap<String, String>, address: Option<&str>) -> BTreeMap<String, String> {
    let mut env = env.clone();
    let port = env.get("HATBOT_PORT").cloned().unwrap_or_default();
    let (host, url) = match address {
        Some(a) => ("0.0.0.0".to_string(), format!("http://{a}:{port}")),
        None => (LOOPBACK.to_string(), format!("http://{LOOPBACK}:{port}")),
    };
    env.insert("HATBOT_HOST".into(), host);
    env.insert("HATBOT_PUBLIC_URL".into(), url);
    env
}

/// The Bun build for this system and processor; x64 without AVX2 needs the baseline one.
pub fn bun_build(os: &str, arch: &str, avx2: bool) -> Option<(&'static str, &'static str)> {
    let arch = match arch {
        "x86_64" if avx2 => "x64",
        "x86_64" => "x64-baseline",
        "aarch64" => "aarch64",
        _ => return None,
    };
    let name = format!("bun-{os}-{arch}");
    BUN_BUILDS.iter().find(|(n, _)| *n == name).copied()
}

fn has_avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

fn on_path(cmd: &str) -> bool {
    let file = format!("{cmd}{}", std::env::consts::EXE_SUFFIX);
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(&file).is_file()))
}

/// PATH with Bun's folder first.
fn bun_path(p: &Paths) -> std::ffi::OsString {
    let dir = p.bun.parent().unwrap_or(Path::new("/")).to_path_buf();
    let rest = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(std::iter::once(dir).chain(std::env::split_paths(&rest))).unwrap_or(rest)
}

/// A command run in the background, with no console window on Windows.
fn command(program: &Path) -> Command {
    let mut c = Command::new(program);
    c.kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(service::NO_WINDOW);
    c
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap_or_default()
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let res = client().get(url).send().await.map_err(|_| format!("Couldn't download {url}."))?;
    if !res.status().is_success() {
        return Err(format!("Couldn't download {url}: {}.", res.status()));
    }
    Ok(res.bytes().await.map_err(|_| format!("The download of {url} broke off."))?.to_vec())
}

async fn run(what: &str, program: &Path, args: &[&str], dir: &Path, p: &Paths) -> Result<(), String> {
    let out = command(program)
        .args(args)
        .current_dir(dir)
        .env("PATH", bun_path(p))
        .output()
        .await
        .map_err(|e| format!("{what} didn't start: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let last = text.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").to_string();
    Err(format!("{what} failed: {last}"))
}

async fn get_bun(p: &Paths) -> Result<(), String> {
    if let Ok(out) = command(&p.bun).arg("--version").output().await
        && String::from_utf8_lossy(&out.stdout).trim() == BUN_VERSION
    {
        return Ok(());
    }
    let (name, sha) = bun_build(std::env::consts::OS, std::env::consts::ARCH, has_avx2())
        .ok_or("Hatbot doesn't run on this kind of processor. Connect to a server instead.")?;
    let zip =
        download(&format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN_VERSION}/{name}.zip")).await?;
    if hex(ring::digest::digest(&ring::digest::SHA256, &zip).as_ref()) != sha {
        return Err("The Bun download isn't the one expected, so it wasn't used.".into());
    }
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| format!("Bun's download won't open: {e}"))?;
    let mut entry = archive
        .by_name(&format!("{name}/bun{}", std::env::consts::EXE_SUFFIX))
        .map_err(|_| "Bun's download has no bun in it.".to_string())?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut bytes).map_err(|e| format!("Bun's download won't open: {e}"))?;
    let dir = p.bun.parent().unwrap_or(Path::new("/"));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("bun.part");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p.bun).map_err(|e| e.to_string())
}

/// The brain at `commit`, downloaded and built once into a folder of its own.
async fn release(p: &Paths, commit: &str, step: &(dyn Fn(&str) + Sync)) -> Result<PathBuf, String> {
    let releases = p.root.join("releases");
    let dir = releases.join(commit);
    if dir.join("release.json").exists() {
        return Ok(dir);
    }
    let part = releases.join(format!("{commit}.part"));
    let _ = std::fs::remove_dir_all(&part);
    std::fs::create_dir_all(&part).map_err(|e| e.to_string())?;
    // Elsewhere to fetch `<commit>.tar.gz` from, such as a build not pushed yet.
    let custom = std::env::var("HATBOT_SOURCE").ok();
    let sources = custom.as_deref().map_or(SOURCES.to_vec(), |s| vec![s]);
    let mut tarball = Err(String::new());
    for base in sources {
        tarball = download(&format!("{base}/{commit}.tar.gz")).await;
        if tarball.is_ok() {
            break;
        }
    }
    let tarball = tarball.map_err(|e| format!("{e} This version of the app may not be published yet."))?;
    let (file_arg, part_arg) = (format!("{commit}.tar.gz"), format!("{commit}.part"));
    let file = releases.join(&file_arg);
    std::fs::write(&file, tarball).map_err(|e| e.to_string())?;
    // Relative to `releases`: a tar that reads C: as a host never sees a drive.
    let untar = run(
        "Unpacking Hatbot",
        Path::new("tar"),
        &["-xzf", &file_arg, "--strip-components=1", "-C", &part_arg],
        &releases,
        p,
    )
    .await;
    let _ = std::fs::remove_file(&file);
    untar?;
    step("Installing packages");
    run("Installing packages", &p.bun, &["install", "--frozen-lockfile"], &part, p).await?;
    step("Building the web app");
    // --bun runs Vite on Bun: there may be no Node here.
    run("Building the web app", &p.bun, &["--bun", "run", "build"], &part.join("apps/web"), p).await?;
    std::fs::write(part.join("release.json"), format!("{{\"sha\":\"{commit}\"}}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn switch_to(p: &Paths, dir: &Path) -> Result<(), String> {
    let next = p.root.join("current.next");
    let _ = std::fs::remove_file(&next);
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir, &next).map_err(|e| e.to_string())?;
    // Symlinks need an administrator on Windows: the file says where it is.
    #[cfg(windows)]
    std::fs::write(&next, dir.display().to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&next, p.root.join("current")).map_err(|e| e.to_string())
}

/// The release the service runs now.
fn installed(p: &Paths) -> Option<PathBuf> {
    #[cfg(unix)]
    return std::fs::read_link(p.root.join("current")).ok();
    #[cfg(windows)]
    return std::fs::read_to_string(p.root.join("current")).ok().map(|s| PathBuf::from(s.trim()));
}

fn free_port() -> u16 {
    (8457..8500).find(|port| std::net::TcpListener::bind((LOOPBACK, *port)).is_ok()).unwrap_or(8457)
}

pub fn server(p: &Paths) -> Option<String> {
    read_env(p).get("HATBOT_PORT").map(|port| format!("http://{LOOPBACK}:{port}"))
}

async fn healthy(server: &str, secs: u64) -> bool {
    let c = client();
    for _ in 0..secs {
        if let Ok(r) = c.get(format!("{server}/api/v1/health")).timeout(Duration::from_secs(2)).send().await
            && r.status().is_success()
        {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    false
}

/// The token the brain writes for this app as it starts.
pub fn token(p: &Paths) -> Option<String> {
    std::fs::read_to_string(p.data.join("app-token")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Downloads, builds and starts the brain, and gives back its address and this app's token.
pub async fn set_up(step: impl Fn(&str) + Sync) -> Result<(String, String), String> {
    if COMMIT.is_empty() {
        return Err("This build of the app doesn't know which Hatbot to set up. Connect to a server instead.".into());
    }
    for cmd in ["git", "tar"] {
        if !on_path(cmd) {
            return Err(format!("Hatbot needs {cmd} on this computer. Install it, then try again."));
        }
    }
    service::check().await?;
    let p = paths();
    step("Downloading Bun");
    get_bun(&p).await?;
    step("Downloading Hatbot");
    let dir = release(&p, COMMIT, &step).await?;
    step("Starting Hatbot");
    let old = read_env(&p);
    let port = old.get("HATBOT_PORT").and_then(|v| v.parse().ok()).unwrap_or_else(free_port);
    std::fs::create_dir_all(p.data.join("archive")).map_err(|e| e.to_string())?;
    // Its secrets and database are the owner's alone (%LOCALAPPDATA% already is).
    #[cfg(unix)]
    std::fs::set_permissions(&p.data, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    write_env(&p, &brain_env(&old, &p.data, port))?;
    switch_to(&p, &dir)?;
    service::install(&p).await?;
    // Started again: a token revoked since is written anew.
    service::restart().await?;
    let server = format!("http://{LOOPBACK}:{port}");
    if !healthy(&server, 90).await {
        return Err(format!("Hatbot didn't start. {}", service::LOGS));
    }
    let token = token(&p).ok_or("Hatbot started but left no sign-in for the app.")?;
    Ok((server, token))
}

/// Brings the brain to this app's commit. The database is copied first, and put back with the old
/// version if the new one doesn't start. Whether it changed anything.
pub async fn update() -> Result<bool, String> {
    let p = paths();
    let Some(old) = installed(&p) else { return Ok(false) };
    let failed = p.root.join("releases").join(COMMIT).join("failed");
    // One that didn't start isn't tried again at every start of the app, each time stopping Hatbot.
    if COMMIT.is_empty() || old.file_name().is_some_and(|n| n == COMMIT) || failed.exists() {
        return Ok(false);
    }
    get_bun(&p).await?;
    let dir = release(&p, COMMIT, &|_| {}).await?;
    let server = server(&p).ok_or("Hatbot's settings on this computer are gone.")?;
    let db = ["hatbot.sqlite", "hatbot.sqlite-wal", "hatbot.sqlite-shm"].map(|f| p.data.join(f));
    let before = |f: &PathBuf| PathBuf::from(format!("{}.before", f.display()));
    service::stop().await?;
    for f in db.iter().filter(|f| f.exists()) {
        std::fs::copy(f, before(f)).map_err(|e| format!("Couldn't copy the database: {e}"))?;
    }
    switch_to(&p, &dir)?;
    service::start().await?;
    if !healthy(&server, 90).await {
        let _ = service::stop().await;
        for f in &db {
            let _ = std::fs::remove_file(f);
            if before(f).exists() {
                let _ = std::fs::rename(before(f), f);
            }
        }
        switch_to(&p, &old)?;
        let _ = std::fs::write(&failed, "");
        service::start().await?;
        return Err("The new version of Hatbot didn't start, so the old one is back.".into());
    }
    // Only the one before stays, to go back to by hand.
    if let Ok(list) = std::fs::read_dir(p.root.join("releases")) {
        for e in list.flatten() {
            let path = e.path();
            if path != dir && path != old {
                let _ = std::fs::remove_dir_all(&path).or_else(|_| std::fs::remove_file(&path));
            }
        }
    }
    Ok(true)
}

/// This computer's address on the network, where other devices reach it.
fn lan_address() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // Connecting a UDP socket sends nothing; it only picks the address a packet would leave from.
    s.connect("192.0.2.1:9").ok()?;
    Some(s.local_addr().ok()?.ip().to_string()).filter(|ip| ip != "0.0.0.0")
}

/// The web app's address when other devices can reach it.
pub fn lan() -> Option<String> {
    let env = read_env(&paths());
    (env.get("HATBOT_HOST").is_some_and(|h| h != LOOPBACK)).then(|| env.get("HATBOT_PUBLIC_URL").cloned()).flatten()
}

pub async fn set_lan(on: bool) -> Result<Option<String>, String> {
    let p = paths();
    let address = if on { Some(lan_address().ok_or("This computer isn't on a network.")?) } else { None };
    write_env(&p, &lan_env(&read_env(&p), address.as_deref()))?;
    service::restart().await?;
    Ok(lan())
}

/// Starts the brain if it isn't running: systemd keeps it so, but on Windows quitting it with the app
/// (an update, say) stops it until the next sign-in.
pub async fn ensure_running() -> Result<(), String> {
    #[cfg(windows)]
    if installed(&paths()).is_some() && !service::running() {
        service::start().await?;
    }
    Ok(())
}

pub use service::supervise;

#[cfg(not(windows))]
mod service {
    use std::path::Path;

    use tokio::process::Command;

    use super::{Paths, xdg};

    const UNIT: &str = "hatbot-brain.service";
    pub const LOGS: &str = "See journalctl --user -u hatbot-brain.";

    fn unit_text(p: &Paths) -> String {
        let bun_dir = p.bun.parent().unwrap_or(Path::new("/")).display().to_string();
        format!(
            "[Unit]\nDescription=Hatbot on this computer\n\n[Service]\nWorkingDirectory={}/current/apps/brain\nEnvironmentFile={}\n\
             Environment=PATH={bun_dir}:/usr/local/bin:/usr/bin:/bin\nExecStart={} src/main.ts\n\
             # A plugin's install exits 75 to start again with it.\nRestart=on-failure\nRestartSec=2\n\n\
             [Install]\nWantedBy=default.target\n",
            p.root.display(),
            p.env.display(),
            p.bun.display(),
        )
    }

    async fn systemctl(args: &[&str]) -> Result<(), String> {
        let out = Command::new("systemctl")
            .arg("--user")
            .args(args)
            .output()
            .await
            .map_err(|_| "Hatbot runs as a systemd user service, and there's no systemd here.".to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("systemctl --user {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
        }
    }

    pub async fn check() -> Result<(), String> {
        systemctl(&["show-environment"])
            .await
            .map(drop)
            .map_err(|_| "Hatbot runs as a systemd user service, and there's no systemd user session here.".to_string())
    }

    pub async fn install(p: &Paths) -> Result<(), String> {
        let unit = xdg("XDG_CONFIG_HOME", ".config").join("systemd/user").join(UNIT);
        std::fs::create_dir_all(unit.parent().unwrap_or(Path::new("/"))).map_err(|e| e.to_string())?;
        std::fs::write(&unit, unit_text(p)).map_err(|e| e.to_string())?;
        systemctl(&["daemon-reload"]).await?;
        systemctl(&["enable", UNIT]).await
    }

    pub async fn start() -> Result<(), String> {
        systemctl(&["start", UNIT]).await
    }

    pub async fn stop() -> Result<(), String> {
        systemctl(&["stop", UNIT]).await
    }

    pub async fn restart() -> Result<(), String> {
        systemctl(&["restart", UNIT]).await
    }

    /// Only Windows runs the brain from the app.
    pub fn supervise() {}
}

#[cfg(windows)]
mod service {
    //! What systemd does for the brain on Linux: `hatbot --brain` runs it, hidden, and starts it again
    //! when it fails or exits 75 for a plugin's install. A job object takes the brain down with it.

    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::time::Duration;

    use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, INFINITE, OpenEventW, OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE,
        SetEvent, WaitForMultipleObjects, WaitForSingleObject,
    };
    use windows::core::w;

    use super::{Paths, bun_path, installed, paths, read_env};

    pub const NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED: u32 = 0x0000_0008;
    const NEW_GROUP: u32 = 0x0000_0200;
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    pub const LOGS: &str = r"See brain.log in %LOCALAPPDATA%\Hatbot.";
    /// Held while `hatbot --brain` runs.
    const RUNNING: windows::core::PCWSTR = w!(r"Local\HatbotBrain");
    /// Set to stop it.
    const STOP: windows::core::PCWSTR = w!(r"Local\HatbotBrainStop");
    const MAX_LOG: u64 = 10 << 20;

    pub async fn check() -> Result<(), String> {
        Ok(())
    }

    pub async fn install(_: &Paths) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        windows_registry::CURRENT_USER
            .create(RUN_KEY)
            .and_then(|k| k.set_string("Hatbot brain", format!("\"{}\" --brain", exe.display())))
            .map_err(|_| "Couldn't set Hatbot to start at sign-in.".to_string())
    }

    pub fn running() -> bool {
        // SAFETY: a handle opened only to see that the mutex exists, and closed.
        unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, RUNNING) }.map(|h| unsafe { CloseHandle(h) }).is_ok()
    }

    pub async fn start() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::process::Command::new(exe)
            .arg("--brain")
            .creation_flags(DETACHED | NEW_GROUP)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(drop)
            .map_err(|e| format!("Hatbot didn't start: {e}"))
    }

    pub async fn stop() -> Result<(), String> {
        // SAFETY: a handle opened to set the event, and closed.
        if let Ok(h) = unsafe { OpenEventW(EVENT_MODIFY_STATE, false, STOP) } {
            unsafe {
                let _ = SetEvent(h);
                let _ = CloseHandle(h);
            }
        }
        for _ in 0..150 {
            if !running() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("Hatbot on this computer didn't stop.".into())
    }

    pub async fn restart() -> Result<(), String> {
        stop().await?;
        start().await
    }

    fn log(p: &Paths) -> Option<std::fs::File> {
        let file = p.root.join("brain.log");
        if std::fs::metadata(&file).is_ok_and(|m| m.len() > MAX_LOG) {
            let _ = std::fs::rename(&file, p.root.join("brain.log.old"));
        }
        std::fs::OpenOptions::new().create(true).append(true).open(file).ok()
    }

    /// `hatbot --brain`: runs the brain until it's stopped or exits cleanly.
    pub fn supervise() {
        // SAFETY: handles of this process's own, kept open until it exits; the job's limits are a
        // plain struct of the size given.
        unsafe {
            let Ok(_held) = CreateMutexW(None, true, RUNNING) else { return };
            if GetLastError() == ERROR_ALREADY_EXISTS {
                return;
            }
            let Ok(stop) = CreateEventW(None, true, false, STOP) else { return };
            let Ok(job) = CreateJobObjectW(None, None) else { return };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            loop {
                let p = paths();
                let Some(dir) = installed(&p) else { return };
                let Some(out) = log(&p) else { return };
                let Ok(err) = out.try_clone() else { return };
                let child = std::process::Command::new(&p.bun)
                    .arg("src/main.ts")
                    .current_dir(dir.join("apps").join("brain"))
                    .envs(read_env(&p))
                    .env("PATH", bun_path(&p))
                    .stdin(std::process::Stdio::null())
                    .stdout(out)
                    .stderr(err)
                    .creation_flags(NO_WINDOW)
                    .spawn();
                let Ok(mut child) = child else { return };
                let process = HANDLE(child.as_raw_handle());
                let _ = AssignProcessToJobObject(job, process);
                if WaitForMultipleObjects(&[stop, process], false, INFINITE) == WAIT_OBJECT_0 {
                    let _ = TerminateJobObject(job, 1);
                    let _ = child.wait();
                    return;
                }
                if child.wait().is_ok_and(|s| s.success()) {
                    return;
                }
                if WaitForSingleObject(stop, 2000) == WAIT_OBJECT_0 {
                    return;
                }
            }
        }
    }
}
