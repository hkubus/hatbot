// The app's token, keyed by the brain's address: in the Secret Service (GNOME Keyring, KWallet,
// KeePassXC) on Linux, in Credential Manager on Windows.

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;

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
        let keyring =
            oo7::Keyring::new().await.map_err(|_| "There's no keyring to keep the sign-in in.".to_string())?;
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
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
    };
    use windows::core::{HSTRING, PWSTR};

    fn target(server: &str) -> HSTRING {
        HSTRING::from(format!("Hatbot token for {server}"))
    }

    pub async fn load(server: &str) -> Option<String> {
        let target = target(server);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            CredReadW(&target, CRED_TYPE_GENERIC, None, &mut cred).ok()?;
            let c = &*cred;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
            CredFree(cred as *const _);
            String::from_utf8(bytes).ok()
        }
    }

    pub async fn save(server: &str, token: &str) -> Result<(), String> {
        let mut name: Vec<u16> = target(server).iter().copied().chain([0]).collect();
        let mut blob = token.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&cred, 0) }.map_err(|_| "Credential Manager didn't take the sign-in.".to_string())
    }

    pub async fn clear(server: &str) {
        let _ = unsafe { CredDeleteW(&target(server), CRED_TYPE_GENERIC, None) };
    }
}

pub use imp::{clear, load, save};
