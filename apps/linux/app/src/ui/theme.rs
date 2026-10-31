// The web app's Material 3 Expressive look: its CSS variables, light and dark, and the widget styles
// built from them.
use iced::border::{self, Border, Radius};
use iced::widget::{button, checkbox, container, pick_list, scrollable, text_editor, text_input, toggler};
use iced::{Background, Color, Font, Shadow, Theme, Vector, font};

pub const TEXT: Font = Font::with_name("Google Sans Flex");
pub const MEDIUM: Font = Font { weight: font::Weight::Medium, ..TEXT };
pub const SEMIBOLD: Font = Font { weight: font::Weight::Semibold, ..TEXT };
pub const CODE: Font = Font::with_name("Google Sans Code");

pub const FONTS: [&[u8]; 9] = [
    include_bytes!("../../fonts/GoogleSansFlex-400.ttf"),
    include_bytes!("../../fonts/GoogleSansFlex-500.ttf"),
    include_bytes!("../../fonts/GoogleSansFlex-600.ttf"),
    include_bytes!("../../fonts/GoogleSansFlex-700.ttf"),
    include_bytes!("../../fonts/GoogleSansCode-400.ttf"),
    include_bytes!("../../fonts/NotoSans-400.ttf"),
    include_bytes!("../../fonts/NotoSans-500.ttf"),
    include_bytes!("../../fonts/NotoSans-600.ttf"),
    include_bytes!("../../fonts/NotoSans-700.ttf"),
];

pub const FS_XS: f32 = 11.0;
pub const FS_SM: f32 = 12.0;
pub const FS_MD: f32 = 14.0;
pub const FS_TEXT: f32 = 15.0;
pub const FS_LG: f32 = 16.0;
pub const FS_XL: f32 = 22.0;
pub const FS_2XL: f32 = 24.0;

pub const R_XS: f32 = 4.0;
pub const R_SM: f32 = 8.0;
pub const R_MD: f32 = 12.0;
pub const R_LG: f32 = 16.0;
pub const R_XL: f32 = 28.0;
pub const PILL: f32 = 999.0;

pub const SP_2XS: f32 = 2.0;
pub const SP_XS: f32 = 4.0;
pub const SP_SM: f32 = 6.0;
pub const SP: f32 = 8.0;
pub const SP_MD: f32 = 12.0;
pub const SP_LG: f32 = 16.0;
pub const SP_XL: f32 = 24.0;
pub const SP_2XL: f32 = 40.0;

pub const H_SM: f32 = 32.0;
pub const H: f32 = 40.0;
pub const H_LG: f32 = 48.0;
pub const MEASURE: f32 = 760.0;
/// A page's width, its gutters included, as the web's `.page`.
pub const PAGE: f32 = 980.0;
pub const ICON: f32 = 20.0;
pub const NAV_ICON: f32 = 24.0;

pub struct Colors {
    pub bg: Color,
    pub bar: Color,
    pub surface_1: Color,
    pub surface_2: Color,
    pub surface_3: Color,
    pub text: Color,
    pub text_2: Color,
    pub muted: Color,
    pub soft: Color,
    pub line: Color,
    pub outline: Color,
    pub hue: Color,
    pub on_hue: Color,
    pub hue_soft: Color,
    pub danger: Color,
    pub danger_soft: Color,
    pub success: Color,
    pub success_soft: Color,
    pub screen: Color,
    pub series: [Color; 3],
    pub bots: [Color; 9],
    pub shadow: Color,
}

const fn hex(v: u32) -> Color {
    Color {
        r: ((v >> 16) & 0xff) as f32 / 255.0,
        g: ((v >> 8) & 0xff) as f32 / 255.0,
        b: (v & 0xff) as f32 / 255.0,
        a: 1.0,
    }
}

/// CSS's `color-mix(in srgb, a share%, b)`.
pub const fn mix(a: Color, share: f32, b: Color) -> Color {
    Color {
        r: a.r * share + b.r * (1.0 - share),
        g: a.g * share + b.g * (1.0 - share),
        b: a.b * share + b.b * (1.0 - share),
        a: 1.0,
    }
}

pub fn alpha(c: Color, a: f32) -> Color {
    Color { a, ..c }
}

pub static LIGHT: Colors = Colors {
    bg: hex(0xfafaf0),
    bar: hex(0xedefe2),
    surface_1: hex(0xf3f5e8),
    surface_2: hex(0xe7eadb),
    surface_3: hex(0xe1e4d4),
    text: hex(0x303429),
    text_2: hex(0x44483c),
    muted: hex(0x5d6154),
    soft: hex(0x787c6f),
    line: hex(0xc5c8b9),
    outline: hex(0x787c6f),
    hue: hex(0x507d12),
    on_hue: hex(0xfafaf0),
    hue_soft: mix(hex(0x507d12), 0.22, hex(0xfafaf0)),
    danger: hex(0xd20f39),
    danger_soft: mix(hex(0xd20f39), 0.22, hex(0xfafaf0)),
    success: hex(0x179299),
    success_soft: mix(hex(0x179299), 0.22, hex(0xfafaf0)),
    screen: hex(0x0d0f0a),
    series: [hex(0x507d12), hex(0x2a78d6), hex(0x138a60)],
    bots: [
        hex(0xfe640b),
        hex(0xd20f39),
        hex(0xea76cb),
        hex(0x8839ef),
        hex(0x7287fd),
        hex(0x1e66f5),
        hex(0x179299),
        hex(0x40a02b),
        hex(0x7c7f93),
    ],
    shadow: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.16 },
};

pub static DARK: Colors = Colors {
    bg: hex(0x181b13),
    bar: hex(0x12140d),
    surface_1: hex(0x1d2118),
    surface_2: hex(0x23271d),
    surface_3: hex(0x2c3125),
    text: hex(0xe4e7d7),
    text_2: hex(0xc9cdbc),
    muted: hex(0xa9ad9e),
    soft: hex(0x85897b),
    line: hex(0x45493d),
    outline: hex(0x73776a),
    hue: hex(0xbbe481),
    on_hue: hex(0x12140d),
    hue_soft: mix(hex(0xbbe481), 0.22, hex(0x181b13)),
    danger: hex(0xf38ba8),
    danger_soft: mix(hex(0xf38ba8), 0.22, hex(0x181b13)),
    success: hex(0x94e2d5),
    success_soft: mix(hex(0x94e2d5), 0.22, hex(0x181b13)),
    screen: hex(0x0d0f0a),
    series: [hex(0xbbe481), hex(0x3987e5), hex(0x199e70)],
    bots: [
        hex(0xfab387),
        hex(0xf38ba8),
        hex(0xf5c2e7),
        hex(0xcba6f7),
        hex(0xb4befe),
        hex(0x89b4fa),
        hex(0x94e2d5),
        hex(0xa6e3a1),
        hex(0x9399b2),
    ],
    shadow: Color { r: 0.0, g: 0.0, b: 0.0, a: 0.5 },
};

pub fn theme(dark: bool) -> Theme {
    let c = if dark { &DARK } else { &LIGHT };
    Theme::custom(
        if dark { "Hatbot dark" } else { "Hatbot light" },
        iced::theme::Palette {
            background: c.bg,
            text: c.text,
            primary: c.hue,
            success: c.success,
            warning: c.hue,
            danger: c.danger,
        },
    )
}

pub fn colors(theme: &Theme) -> &'static Colors {
    if theme.extended_palette().is_dark { &DARK } else { &LIGHT }
}

/// A bot's colour by its name in `BOT_COLORS`.
pub fn bot_color(theme: &Theme, name: &str) -> Color {
    let c = colors(theme);
    let i = crate::core::models::BOT_COLORS.iter().position(|n| *n == name).unwrap_or(0);
    c.bots[i.min(c.bots.len() - 1)]
}

fn hover(on: Color, status: button::Status) -> Option<Background> {
    match status {
        button::Status::Hovered => Some(alpha(on, 0.08).into()),
        button::Status::Pressed => Some(alpha(on, 0.12).into()),
        _ => None,
    }
}

/// Lays the state layer over a filled background.
fn layered(base: Color, on: Color, status: button::Status) -> Background {
    match status {
        button::Status::Hovered => mix(on, 0.08, base).into(),
        button::Status::Pressed => mix(on, 0.12, base).into(),
        _ => base.into(),
    }
}

fn round(r: f32) -> Border {
    Border { radius: r.into(), ..Border::default() }
}

fn disabled(mut s: button::Style, status: button::Status) -> button::Style {
    if status == button::Status::Disabled {
        s.text_color = alpha(s.text_color, 0.38);
        s.background = s.background.map(|b| match b {
            Background::Color(c) => Background::Color(alpha(c, 0.38)),
            other => other,
        });
        s.border.color = alpha(s.border.color, 0.38);
    }
    s
}

/// `.btn`: outlined.
pub fn outlined(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    disabled(
        button::Style {
            background: hover(c.text_2, status),
            text_color: c.text_2,
            border: Border { color: c.line, width: 1.0, radius: PILL.into() },
            ..button::Style::default()
        },
        status,
    )
}

/// `.btn.primary`: what needs you, filled with the accent.
pub fn primary(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    disabled(
        button::Style {
            background: Some(layered(c.hue, c.on_hue, status)),
            text_color: c.on_hue,
            border: round(PILL),
            ..button::Style::default()
        },
        status,
    )
}

pub fn danger(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    disabled(
        button::Style {
            background: Some(layered(c.danger, c.on_hue, status)),
            text_color: c.on_hue,
            border: round(PILL),
            ..button::Style::default()
        },
        status,
    )
}

/// Deny: outlined, in red.
pub fn deny(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    disabled(
        button::Style {
            background: hover(c.danger, status),
            text_color: c.danger,
            border: Border { color: c.line, width: 1.0, radius: PILL.into() },
            ..button::Style::default()
        },
        status,
    )
}

/// The accent's soft tone: a chosen chip or a second choice.
pub fn tonal(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    disabled(
        button::Style {
            background: Some(layered(c.hue_soft, c.text, status)),
            text_color: c.text,
            border: round(PILL),
            ..button::Style::default()
        },
        status,
    )
}

/// A text button, or an icon button with no fill.
pub fn plain(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    disabled(
        button::Style {
            background: hover(c.text_2, status),
            text_color: c.text_2,
            border: round(PILL),
            ..button::Style::default()
        },
        status,
    )
}

/// A tab: the state layer without a pill.
pub fn plain_square(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    button::Style { background: hover(c.text_2, status), text_color: c.text_2, ..button::Style::default() }
}

pub fn link(theme: &Theme, status: button::Status) -> button::Style {
    let c = colors(theme);
    button::Style {
        background: None,
        text_color: if status == button::Status::Hovered { c.text } else { c.hue },
        ..button::Style::default()
    }
}

/// A sidebar or list row: the chosen one sits on the accent's soft pill.
pub fn nav(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let c = colors(theme);
        let background = if active { Some(layered(c.hue_soft, c.text, status)) } else { hover(c.text_2, status) };
        button::Style {
            background,
            text_color: if active { c.text } else { c.text_2 },
            border: round(PILL),
            ..button::Style::default()
        }
    }
}

/// A row in a list of cards, squared to the list's corners.
pub fn row(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let c = colors(theme);
        let base = if active { c.hue_soft } else { c.surface_1 };
        button::Style {
            background: Some(layered(base, c.text, status)),
            text_color: c.text,
            border: round(R_LG),
            ..button::Style::default()
        }
    }
}

/// A toggle that squares off and fills when on, as Expressive's do.
pub fn toggle(on: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        if on {
            let c = colors(theme);
            button::Style {
                background: Some(layered(c.hue, c.on_hue, status)),
                text_color: c.on_hue,
                border: round(R_MD),
                ..button::Style::default()
            }
        } else {
            plain(theme, status)
        }
    }
}

pub fn chip(on: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let c = colors(theme);
        if on {
            button::Style {
                background: Some(layered(c.hue_soft, c.text, status)),
                text_color: c.text,
                border: round(R_SM),
                ..button::Style::default()
            }
        } else {
            button::Style {
                background: hover(c.text_2, status),
                text_color: c.text_2,
                border: Border { color: c.line, width: 1.0, radius: R_SM.into() },
                ..button::Style::default()
            }
        }
    }
}

pub fn page(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style { background: Some(c.bg.into()), text_color: Some(c.text), ..Default::default() }
}

pub fn bar(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style { background: Some(c.bar.into()), text_color: Some(c.text), ..Default::default() }
}

/// The page sits in the bars' frame with its top-left corner rounded.
pub fn framed(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style {
        background: Some(c.bg.into()),
        text_color: Some(c.text),
        border: Border { radius: Radius::default().top_left(R_XL), ..Border::default() },
        ..Default::default()
    }
}

pub fn card(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style { background: Some(c.surface_1.into()), border: round(R_LG), ..Default::default() }
}

/// One row of a group: the web's segmented list, rounded more where the group starts and ends.
pub fn tile(first: bool, last: bool) -> impl Fn(&Theme) -> container::Style {
    move |theme| {
        let c = colors(theme);
        let (top, bottom) = (if first { R_LG } else { R_XS }, if last { R_LG } else { R_XS });
        container::Style {
            background: Some(c.surface_1.into()),
            border: Border {
                radius: Radius::default().top_left(top).top_right(top).bottom_left(bottom).bottom_right(bottom),
                ..Border::default()
            },
            ..Default::default()
        }
    }
}

pub fn well(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style { background: Some(c.surface_2.into()), border: round(R_XL), ..Default::default() }
}

pub fn code_block(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style { background: Some(c.surface_2.into()), border: round(R_MD), ..Default::default() }
}

/// What needs you: the soft accent.
pub fn attention(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style {
        background: Some(c.hue_soft.into()),
        text_color: Some(c.text),
        border: round(R_LG),
        ..Default::default()
    }
}

pub fn danger_box(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style {
        background: Some(c.danger_soft.into()),
        text_color: Some(c.text),
        border: round(R_LG),
        ..Default::default()
    }
}

pub fn user_bubble(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style {
        background: Some(c.hue.into()),
        text_color: Some(c.on_hue),
        border: round(20.0),
        ..Default::default()
    }
}

pub fn badge(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style {
        background: Some(c.hue.into()),
        text_color: Some(c.on_hue),
        border: round(PILL),
        ..Default::default()
    }
}

pub fn screen(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style { background: Some(c.screen.into()), border: round(R_LG), ..Default::default() }
}

pub fn dialog(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style {
        background: Some(c.surface_3.into()),
        text_color: Some(c.text),
        border: round(R_XL),
        shadow: Shadow { color: c.shadow, offset: Vector::new(0.0, 4.0), blur_radius: 16.0 },
        ..Default::default()
    }
}

pub fn scrim(_: &Theme) -> container::Style {
    container::Style { background: Some(alpha(Color::BLACK, 0.32).into()), ..Default::default() }
}

pub fn toast(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style {
        background: Some(c.text.into()),
        text_color: Some(c.bg),
        border: round(R_SM),
        ..Default::default()
    }
}

pub fn line(theme: &Theme) -> container::Style {
    let c = colors(theme);
    container::Style { background: Some(c.line.into()), ..Default::default() }
}

pub fn input(theme: &Theme, status: text_input::Status) -> text_input::Style {
    let c = colors(theme);
    let focused = matches!(status, text_input::Status::Focused { .. });
    text_input::Style {
        background: c.surface_2.into(),
        border: Border { color: if focused { c.hue } else { c.surface_2 }, width: 2.0, radius: R_MD.into() },
        icon: c.muted,
        placeholder: c.soft,
        value: c.text,
        selection: alpha(c.hue, 0.35),
    }
}

/// The composer's field: the box around it shows the focus.
pub fn composer_field(theme: &Theme, _: text_editor::Status) -> text_editor::Style {
    let c = colors(theme);
    text_editor::Style {
        background: Color::TRANSPARENT.into(),
        border: Border::default(),
        placeholder: c.soft,
        value: c.text,
        selection: alpha(c.hue, 0.35),
    }
}

pub fn editor(theme: &Theme, status: text_editor::Status) -> text_editor::Style {
    let c = colors(theme);
    let focused = matches!(status, text_editor::Status::Focused { .. });
    text_editor::Style {
        background: c.surface_2.into(),
        border: Border { color: if focused { c.hue } else { c.surface_2 }, width: 2.0, radius: R_MD.into() },
        placeholder: c.soft,
        value: c.text,
        selection: alpha(c.hue, 0.35),
    }
}

pub fn switch(theme: &Theme, status: toggler::Status) -> toggler::Style {
    let c = colors(theme);
    let (on, hovered, off) = match status {
        toggler::Status::Active { is_toggled } => (is_toggled, false, false),
        toggler::Status::Hovered { is_toggled } => (is_toggled, true, false),
        toggler::Status::Disabled { is_toggled } => (is_toggled, false, true),
    };
    let fade = |col: Color| if off { alpha(col, 0.38) } else { col };
    let track = if on { c.hue } else { c.surface_3 };
    toggler::Style {
        background: fade(if hovered { mix(c.text, 0.08, track) } else { track }).into(),
        background_border_width: if on { 0.0 } else { 2.0 },
        background_border_color: fade(c.outline),
        foreground: fade(if on { c.on_hue } else { c.outline }).into(),
        foreground_border_width: 0.0,
        foreground_border_color: Color::TRANSPARENT,
        text_color: Some(c.text),
        border_radius: None,
        padding_ratio: if on { 0.12 } else { 0.22 },
    }
}

pub fn check(theme: &Theme, status: checkbox::Status) -> checkbox::Style {
    let c = colors(theme);
    let (on, hovered) = match status {
        checkbox::Status::Active { is_checked } | checkbox::Status::Disabled { is_checked } => (is_checked, false),
        checkbox::Status::Hovered { is_checked } => (is_checked, true),
    };
    let box_bg = if on {
        c.hue
    } else if hovered {
        alpha(c.text, 0.08)
    } else {
        Color::TRANSPARENT
    };
    checkbox::Style {
        background: box_bg.into(),
        icon_color: c.on_hue,
        border: Border { color: if on { c.hue } else { c.outline }, width: 2.0, radius: Radius::from(R_XS) },
        text_color: Some(c.text),
    }
}

pub fn select(theme: &Theme, status: pick_list::Status) -> pick_list::Style {
    let c = colors(theme);
    let open = matches!(status, pick_list::Status::Opened { .. });
    pick_list::Style {
        text_color: c.text,
        placeholder_color: c.soft,
        handle_color: c.muted,
        background: (if matches!(status, pick_list::Status::Hovered) { c.surface_3 } else { c.surface_2 }).into(),
        border: Border { color: if open { c.hue } else { c.surface_2 }, width: 2.0, radius: R_MD.into() },
    }
}

pub fn scroll(theme: &Theme, status: scrollable::Status) -> scrollable::Style {
    let c = colors(theme);
    let mut s = scrollable::default(theme, status);
    let thumb = |on: bool| scrollable::Scroller {
        background: (if on { c.outline } else { alpha(c.outline, 0.5) }).into(),
        border: border::rounded(PILL),
    };
    let (v, h) = match status {
        scrollable::Status::Hovered {
            is_vertical_scrollbar_hovered: v, is_horizontal_scrollbar_hovered: h, ..
        } => (v, h),
        scrollable::Status::Dragged {
            is_vertical_scrollbar_dragged: v, is_horizontal_scrollbar_dragged: h, ..
        } => (v, h),
        _ => (false, false),
    };
    s.vertical_rail = scrollable::Rail { background: None, border: Border::default(), scroller: thumb(v) };
    s.horizontal_rail = scrollable::Rail { background: None, border: Border::default(), scroller: thumb(h) };
    s
}
