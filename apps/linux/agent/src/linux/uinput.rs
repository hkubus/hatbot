//! The keyboard: a uinput device, so keys go through the compositor's own keymap like a real
//! keyboard's. niri's virtual keyboard protocol mangles keymaps. Needs the udev rule from
//! packaging/ (`KERNEL=="uinput", TAG+="uaccess"`).

use evdev::uinput::VirtualDevice;
use evdev::{AttributeSet, EventType, InputEvent, KeyCode};

pub struct Keyboard(VirtualDevice);

impl Keyboard {
    pub fn open() -> Result<Self, String> {
        let mut keys = AttributeSet::<KeyCode>::new();
        // Every keyboard key; buttons from 0x100 on belong to pointers.
        for code in 1..0x100 {
            keys.insert(KeyCode::new(code));
        }
        let dev = VirtualDevice::builder()
            .and_then(|b| b.name("Hatbot keyboard").with_keys(&keys))
            .and_then(|b| b.build())
            .map_err(|e| {
                format!(
                    "Can't type: /dev/uinput can't be opened ({e}). Install Hatbot's udev rule and log in again."
                )
            })?;
        Ok(Self(dev))
    }

    pub fn key(&mut self, code: KeyCode, down: bool) -> Result<(), String> {
        self.0
            .emit(&[InputEvent::new(EventType::KEY.0, code.code(), down as i32)])
            .map_err(|e| format!("Can't type: {e}."))
    }
}
