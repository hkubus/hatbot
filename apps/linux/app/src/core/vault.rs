// The bearer token in the Secret Service (GNOME Keyring, KWallet, KeePassXC), keyed by the brain's
// address; the address and this computer's switch in ~/.config/hatbot/app.json.
use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

fn attributes(server: &str) -> HashMap<&str, &str> {
    HashMap::from([("application", "ovh.gaycats.Hatbot"), ("server", server)])
}

pub async fn load(server: &str) -> Option<String> {
    let keyring = oo7::Keyring::new().await.ok()?;
    let _ = keyring.unlock().await;
    let items = keyring.search_items(&attributes(server)).await.ok()?;
    let secret = items.first()?.secret().await.ok()?;
    String::from_utf8(secret.to_vec()).ok()
}

pub async fn save(server: &str, token: &str) -> Result<(), String> {
    let keyring = oo7::Keyring::new().await.map_err(|_| "There's no keyring to keep the sign-in in.".to_string())?;
    let _ = keyring.unlock().await;
    keyring
        .create_item(&format!("Hatbot token for {server}"), &attributes(server), token, true)
        .await
        .map_err(|_| "The keyring didn't take the sign-in.".to_string())
}

pub async fn clear(server: &str) {
    if let Ok(keyring) = oo7::Keyring::new().await {
        let _ = keyring.delete(&attributes(server)).await;
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server: Option<String>,
    /// "Let Hatbot use this computer": only ever switched here.
    pub computer_enabled: bool,
}

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
