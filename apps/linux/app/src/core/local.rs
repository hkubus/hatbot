// Hatbot's brain on this computer, for running it without a server: Bun and the brain at this app's own
// commit under ~/.local/share/hatbot, run by a systemd user service that starts at login.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

pub const COMMIT: &str = env!("HATBOT_COMMIT");
const BUN_VERSION: &str = "1.4.2";
/// From the release's SHASUMS256.txt.
const BUN_BUILDS: [(&str, &str); 3] = [
    ("bun-linux-x64", "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"),
    ("bun-linux-x64-baseline", "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"),
    ("bun-linux-aarch64", "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"),
];
/// Forgejo sometimes hangs, so the GitHub mirror goes first.
const SOURCES: [&str; 2] = ["https://github.com/hkubus/hatbot/archive", "https://git.gaycats.ovh/kubus/hatbot/archive"];
const UNIT: &str = "hatbot-brain.service";
const LOOPBACK: &str = "127.0.0.1";

pub struct Paths {
    pub root: PathBuf,
    pub bun: PathBuf,
    pub data: PathBuf,
    pub env: PathBuf,
    pub unit: PathBuf,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home().join(fallback))
}

pub fn paths() -> Paths {
    let root = xdg("XDG_DATA_HOME", ".local/share").join("hatbot");
    Paths {
        bun: root.join("bun/bun"),
        data: root.join("data"),
        env: super::vault::config_dir().join("brain.env"),
        unit: xdg("XDG_CONFIG_HOME", ".config").join("systemd/user").join(UNIT),
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
    env.insert("HATBOT_UPDATE_DIR".into(), format!("{data}/update"));
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

/// The Bun build for this processor; x64 without AVX2 needs the baseline one.
pub fn bun_build(arch: &str, avx2: bool) -> Option<(&'static str, &'static str)> {
    let name = match arch {
        "x86_64" if avx2 => "bun-linux-x64",
        "x86_64" => "bun-linux-x64-baseline",
        "aarch64" => "bun-linux-aarch64",
        _ => return None,
    };
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
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file()))
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
    let path =
        format!("{}:{}", p.bun.parent().unwrap_or(Path::new("/")).display(), std::env::var("PATH").unwrap_or_default());
    let out = Command::new(program)
        .args(args)
        .current_dir(dir)
        .env("PATH", path)
        .kill_on_drop(true)
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

async fn get_bun(p: &Paths) -> Result<(), String> {
    if let Ok(out) = Command::new(&p.bun).arg("--version").output().await
        && String::from_utf8_lossy(&out.stdout).trim() == BUN_VERSION
    {
        return Ok(());
    }
    let (name, sha) = bun_build(std::env::consts::ARCH, has_avx2())
        .ok_or("Hatbot doesn't run on this kind of processor. Connect to a server instead.")?;
    let zip =
        download(&format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN_VERSION}/{name}.zip")).await?;
    if hex(ring::digest::digest(&ring::digest::SHA256, &zip).as_ref()) != sha {
        return Err("The Bun download isn't the one expected, so it wasn't used.".into());
    }
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| format!("Bun's download won't open: {e}"))?;
    let mut entry =
        archive.by_name(&format!("{name}/bun")).map_err(|_| "Bun's download has no bun in it.".to_string())?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut bytes).map_err(|e| format!("Bun's download won't open: {e}"))?;
    let dir = p.bun.parent().unwrap_or(Path::new("/"));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("bun.part");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
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
    let file = releases.join(format!("{commit}.tar.gz"));
    std::fs::write(&file, tarball).map_err(|e| e.to_string())?;
    let file_arg = file.display().to_string();
    let part_arg = part.display().to_string();
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
    std::os::unix::fs::symlink(dir, &next).map_err(|e| e.to_string())?;
    std::fs::rename(&next, p.root.join("current")).map_err(|e| e.to_string())
}

/// The commit the service runs now.
fn installed(p: &Paths) -> Option<PathBuf> {
    std::fs::read_link(p.root.join("current")).ok()
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
    systemctl(&["show-environment"])
        .await
        .map_err(|_| "Hatbot runs as a systemd user service, and there's no systemd user session here.".to_string())?;
    let p = paths();
    step("Downloading Bun");
    get_bun(&p).await?;
    step("Downloading Hatbot");
    let dir = release(&p, COMMIT, &step).await?;
    step("Starting Hatbot");
    let old = read_env(&p);
    let port = old.get("HATBOT_PORT").and_then(|v| v.parse().ok()).unwrap_or_else(free_port);
    std::fs::create_dir_all(p.data.join("archive")).map_err(|e| e.to_string())?;
    // Its secrets and database are the owner's alone.
    std::fs::set_permissions(&p.data, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    write_env(&p, &brain_env(&old, &p.data, port))?;
    std::fs::create_dir_all(p.unit.parent().unwrap_or(Path::new("/"))).map_err(|e| e.to_string())?;
    std::fs::write(&p.unit, unit_text(&p)).map_err(|e| e.to_string())?;
    switch_to(&p, &dir)?;
    systemctl(&["daemon-reload"]).await?;
    systemctl(&["enable", UNIT]).await?;
    // Started again: a token revoked since is written anew.
    systemctl(&["restart", UNIT]).await?;
    let server = format!("http://{LOOPBACK}:{port}");
    if !healthy(&server, 90).await {
        return Err("Hatbot didn't start. See journalctl --user -u hatbot-brain.".into());
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
    systemctl(&["stop", UNIT]).await?;
    for f in db.iter().filter(|f| f.exists()) {
        std::fs::copy(f, before(f)).map_err(|e| format!("Couldn't copy the database: {e}"))?;
    }
    switch_to(&p, &dir)?;
    systemctl(&["start", UNIT]).await?;
    if !healthy(&server, 90).await {
        let _ = systemctl(&["stop", UNIT]).await;
        for f in &db {
            let _ = std::fs::remove_file(f);
            if before(f).exists() {
                let _ = std::fs::rename(before(f), f);
            }
        }
        switch_to(&p, &old)?;
        let _ = std::fs::write(&failed, "");
        systemctl(&["start", UNIT]).await?;
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
    systemctl(&["restart", UNIT]).await?;
    Ok(lan())
}
