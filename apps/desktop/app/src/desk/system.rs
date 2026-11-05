// Windows learns of the app from the registry, for the current user: its name for notifications, the
// hatbot:// links ntfy's notifications open, and starting at sign-in. Linux has the package's desktop
// file and systemd unit for that.

pub const APP_ID: &str = "ovh.gaycats.Hatbot";

#[cfg(windows)]
pub fn register() {
    use windows_registry::CURRENT_USER;
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.display().to_string();
    let set = |path: &str, name: &str, value: &str| {
        let _ = CURRENT_USER.create(path).and_then(|k| k.set_string(name, value));
    };
    let ids = format!(r"Software\Classes\AppUserModelId\{APP_ID}");
    set(&ids, "DisplayName", "Hatbot");
    set(&ids, "IconUri", &exe);
    set(r"Software\Classes\hatbot", "", "URL:Hatbot");
    set(r"Software\Classes\hatbot", "URL Protocol", "");
    set(r"Software\Classes\hatbot\shell\open\command", "", &format!("\"{exe}\" \"%1\""));
    set(r"Software\Microsoft\Windows\CurrentVersion\Run", "Hatbot", &format!("\"{exe}\" --daemon"));
    unsafe {
        let _ =
            windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(APP_ID));
    }
}

#[cfg(not(windows))]
pub fn register() {}
