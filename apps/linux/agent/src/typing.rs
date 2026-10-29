//! Which keys type a text on the owner's current layout, and when it has to be pasted instead.

use std::collections::HashMap;

use evdev::KeyCode;

/// One key press that types a character: the key, and the levels it needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stroke {
    pub code: KeyCode,
    pub shift: bool,
    /// Level three, on AltGr (right Alt).
    pub altgr: bool,
}

impl Stroke {
    pub const fn plain(code: KeyCode) -> Self {
        Self { code, shift: false, altgr: false }
    }
}

/// The characters each layout of the keymap types, read once from xkb.
#[derive(Debug, Clone, Default)]
pub struct KeyTable {
    layouts: Vec<HashMap<char, Stroke>>,
    /// The layout in use now.
    pub current: usize,
}

impl KeyTable {
    pub fn new(layouts: Vec<HashMap<char, Stroke>>, current: usize) -> Self {
        Self { layouts, current }
    }

    /// The key for a character on the current layout.
    pub fn stroke(&self, c: char) -> Option<Stroke> {
        self.layouts.get(self.current)?.get(&c).copied()
    }

    /// For a shortcut ("ctrl+c" on a Cyrillic layout): the current layout's key, else the first
    /// layout's that has it. Apps read shortcuts through a Latin layout too.
    pub fn shortcut(&self, c: char) -> Option<Stroke> {
        self.stroke(c).or_else(|| self.layouts.iter().find_map(|l| l.get(&c).copied()))
    }

    /// Reads an xkb keymap, as the compositor gives it.
    pub fn from_keymap(text: &str) -> Option<Self> {
        use xkbcommon::xkb;
        let ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let keymap = xkb::Keymap::new_from_string(
            &ctx,
            text.to_owned(),
            xkb::KEYMAP_FORMAT_TEXT_V1,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )?;
        Some(Self::from_xkb(&keymap))
    }

    /// The system's default keymap, from XKB_DEFAULT_LAYOUT and friends, when the compositor gave none.
    pub fn default_keymap() -> Option<Self> {
        use xkbcommon::xkb;
        let ctx = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let keymap =
            xkb::Keymap::new_from_names(&ctx, "", "", "", "", None, xkb::KEYMAP_COMPILE_NO_FLAGS)?;
        Some(Self::from_xkb(&keymap))
    }

    fn from_xkb(keymap: &xkbcommon::xkb::Keymap) -> Self {
        use xkbcommon::xkb;
        let shift = 1u32 << keymap.mod_get_index(xkb::MOD_NAME_SHIFT);
        // Level three is Mod5 on every common layout, through AltGr.
        let altgr = 1u32 << keymap.mod_get_index("Mod5");
        let mut layouts = vec![HashMap::new(); keymap.num_layouts() as usize];
        for code in keymap.min_keycode().raw()..=keymap.max_keycode().raw().min(255 + 8) {
            let key = xkb::Keycode::new(code);
            let Some(evdev) = code.checked_sub(8) else { continue };
            for (layout, table) in layouts.iter_mut().enumerate() {
                let layout = layout as u32;
                for level in 0..keymap.num_levels_for_key(key, layout) {
                    let syms = keymap.key_get_syms_by_level(key, layout, level);
                    let [sym] = syms else { continue };
                    let Some(c) = char::from_u32(xkb::keysym_to_utf32(*sym)).filter(|c| *c != '\0')
                    else {
                        continue;
                    };
                    let mut masks = [0u32; 8];
                    let n = keymap.key_get_mods_for_level(key, layout, level, &mut masks);
                    // The simplest way to reach the level with only Shift and AltGr, if any.
                    let Some(mask) = masks[..n.min(8)]
                        .iter()
                        .copied()
                        .filter(|m| m & !(shift | altgr) == 0)
                        .min_by_key(|m| m.count_ones())
                    else {
                        continue;
                    };
                    let stroke = Stroke {
                        code: KeyCode::new(evdev as u16),
                        shift: mask & shift != 0,
                        altgr: mask & altgr != 0,
                    };
                    // Prefer the main keyboard's keys and the fewest modifiers over the keypad's.
                    table
                        .entry(c)
                        .and_modify(|s: &mut Stroke| {
                            if rank(stroke) < rank(*s) {
                                *s = stroke;
                            }
                        })
                        .or_insert(stroke);
                }
            }
        }
        Self { layouts, current: 0 }
    }
}

fn rank(s: Stroke) -> (bool, u8, u16) {
    let keypad = (71..=83).contains(&s.code.code()) || s.code.code() == 98 || s.code.code() == 55;
    (keypad, s.shift as u8 + s.altgr as u8 * 2, s.code.code())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypePlan {
    Keys(Vec<Stroke>),
    /// Some character isn't on the layout: the whole text goes through the clipboard.
    Paste,
}

/// Keys for a text on the current layout. Newlines press Return and tabs Tab.
pub fn plan(text: &str, table: &KeyTable) -> TypePlan {
    let mut keys = Vec::with_capacity(text.len());
    for c in text.chars() {
        let stroke = match c {
            '\r' => continue,
            '\n' => Stroke::plain(KeyCode::KEY_ENTER),
            '\t' => Stroke::plain(KeyCode::KEY_TAB),
            c => match table.stroke(c) {
                Some(s) => s,
                None => return TypePlan::Paste,
            },
        };
        keys.push(stroke);
    }
    TypePlan::Keys(keys)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A US layout's letters and a Czech one's, enough to tell them apart.
    pub fn table() -> KeyTable {
        let us: HashMap<char, Stroke> = [
            ('a', Stroke::plain(KeyCode::KEY_A)),
            ('A', Stroke { code: KeyCode::KEY_A, shift: true, altgr: false }),
            ('c', Stroke::plain(KeyCode::KEY_C)),
            (' ', Stroke::plain(KeyCode::KEY_SPACE)),
            ('2', Stroke::plain(KeyCode::KEY_2)),
        ]
        .into();
        let cz: HashMap<char, Stroke> = [
            ('a', Stroke::plain(KeyCode::KEY_A)),
            ('ě', Stroke::plain(KeyCode::KEY_2)),
            ('@', Stroke { code: KeyCode::KEY_V, shift: false, altgr: true }),
        ]
        .into();
        KeyTable::new(vec![us, cz], 0)
    }

    #[test]
    fn types_what_the_current_layout_has_and_pastes_the_rest() {
        let mut t = table();
        let TypePlan::Keys(keys) = plan("Aa a\r\n", &t) else { panic!("should type") };
        assert_eq!(keys.len(), 5);
        assert!(keys[0].shift);
        assert_eq!(keys[4].code, KeyCode::KEY_ENTER);
        assert_eq!(plan("ě", &t), TypePlan::Paste);
        assert_eq!(plan("emoji 🙂", &t), TypePlan::Paste);
        t.current = 1;
        assert_eq!(
            plan("ě@", &t),
            TypePlan::Keys(vec![
                Stroke::plain(KeyCode::KEY_2),
                Stroke { code: KeyCode::KEY_V, shift: false, altgr: true },
            ])
        );
        // A shortcut's letter the current layout lacks comes from another layout.
        assert_eq!(t.shortcut('c'), Some(Stroke::plain(KeyCode::KEY_C)));
    }

    #[test]
    fn reads_a_real_keymap() {
        let Some(t) = KeyTable::default_keymap() else { return };
        let s = t.stroke('A').expect("A on the default layout");
        assert!(s.shift);
    }
}
