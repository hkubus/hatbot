// The brain's address and this computer's switch, in the app's config folder: ~/.config/hatbot/app.json,
// or %APPDATA%\Hatbot\app.json on Windows. The token is in the system's keyring (`desk::keyring`).
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server: Option<String>,
    /// The brain is the one this app set up on this computer (`core::local`).
    pub local: bool,
    /// "Let Hatbot use this computer": only ever switched here.
    pub computer_enabled: bool,
}

#[cfg(windows)]
pub fn config_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("Hatbot")
}

#[cfg(not(windows))]
pub fn config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"))
        .join("hatbot")
}

pub fn load_config() -> Config {
    std::fs::read(config_dir().join("app.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_config(c: &Config) {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_vec_pretty(c) {
        let tmp = dir.join("app.json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, dir.join("app.json"));
        }
    }
}
