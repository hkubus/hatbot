// The bearer token in the Secret Service (GNOME Keyring, KWallet, KeePassXC), keyed by the brain's
// address; the address itself in ~/.config/hatbot/hatbot.conf.
use std::collections::HashMap;
use std::path::PathBuf;

use gtk::glib;
use libsecret::{Schema, SchemaAttributeType, SchemaFlags};

fn schema() -> Schema {
    let attributes = HashMap::from([("server", SchemaAttributeType::String)]);
    Schema::new("ovh.gaycats.Hatbot.Token", SchemaFlags::NONE, attributes)
}

pub async fn load(server: &str) -> Option<String> {
    let attributes = HashMap::from([("server", server)]);
    libsecret::password_lookup_future(Some(&schema()), attributes)
        .await
        .ok()
        .flatten()
        .map(|t| t.to_string())
}

pub async fn save(server: &str, token: &str) -> Result<(), glib::Error> {
    let attributes = HashMap::from([("server", server)]);
    let label = format!("Hatbot token for {server}");
    libsecret::password_store_future(
        Some(&schema()),
        attributes,
        Some(libsecret::COLLECTION_DEFAULT),
        &label,
        token,
    )
    .await
}

pub async fn clear(server: &str) {
    let attributes = HashMap::from([("server", server)]);
    let _ = libsecret::password_clear_future(Some(&schema()), attributes).await;
}

fn config_path() -> PathBuf {
    glib::user_config_dir().join("hatbot").join("hatbot.conf")
}

/// The brain's address saved at sign-in, if any.
pub fn saved_server() -> Option<String> {
    let file = glib::KeyFile::new();
    file.load_from_file(config_path(), glib::KeyFileFlags::NONE)
        .ok()?;
    file.string("brain", "address")
        .ok()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

pub fn save_server(server: &str) {
    let path = config_path();
    let file = glib::KeyFile::new();
    let _ = file.load_from_file(&path, glib::KeyFileFlags::KEEP_COMMENTS);
    file.set_string("brain", "address", server);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = file.save_to_file(&path);
}
