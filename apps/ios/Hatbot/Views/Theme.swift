// Material 3 Expressive, as the web app has it, for what you read and press in the page: Google Sans,
// the lime's tinted surfaces, pill buttons and segmented lists. Liquid Glass (Glass.swift) stays for the
// bars and controls floating over it, as Google's own iOS apps do.
import SwiftUI
import UIKit

extension Color {
  /// Hatbot's lime, the web's `--hue`: a deep green in light mode, where lime itself is too pale on white.
  /// It's also what needs you, as on the web; red is deny and errors, teal done.
  static let brand = Color(light: 0x507D12, dark: 0xBBE481)
  static let attention = Color.brand
  /// Your messages, on the brand's colour like the web's.
  static let userBubble = Color.brand
  /// Text and glyphs on the brand's colour: 5.0:1 in light mode, 13:1 in dark.
  static let onBrand = Color(light: 0xFAFAF0, dark: 0x12140D)
  /// What's chosen: the drawer's open section, a chosen option.
  static let brandSoft = Color(light: 0xD5DEBF, dark: 0x3C472B)

  /// The web's surfaces, Material's neutrals tinted from the lime: the page, then tiles and cards on it.
  static let surface = Color(light: 0xFAFAF0, dark: 0x181B13)
  static let surface1 = Color(light: 0xF3F5E8, dark: 0x1D2118)
  static let surface2 = Color(light: 0xE7EADB, dark: 0x23271D)
  static let surface3 = Color(light: 0xE1E4D4, dark: 0x2C3125)
  static let tonal = Color(light: 0xD6D9C8, dark: 0x2C3125)
  static let text = Color(light: 0x303429, dark: 0xE4E7D7)
  static let text2 = Color(light: 0x44483C, dark: 0xC9CDBC)
  static let line = Color(light: 0xC5C8B9, dark: 0x45493D)

  static let danger = Color(light: 0xD20F39, dark: 0xF38BA8)
  static let dangerSoft = Color(light: 0xF1C6C8, dark: 0x483434)
  static let success = Color(light: 0x179299, dark: 0x94E2D5)
  static let successSoft = Color(light: 0xC8E3DD, dark: 0x33473E)

  init(light: UInt32, dark: UInt32, darkOpacity: CGFloat = 1) {
    self.init(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: darkOpacity) : UIColor(hex: light, alpha: 1)
      })
  }
}

extension Bot.Tint {
  /// Catppuccin's, Latte in light mode and Mocha in dark, as on the web.
  var color: Color {
    switch self {
    case .amber: Catppuccin.amber
    case .red: Catppuccin.red
    case .pink: Catppuccin.pink
    case .purple: Catppuccin.purple
    case .indigo: Catppuccin.indigo
    case .blue: Catppuccin.blue
    case .teal: Catppuccin.teal
    case .green: Catppuccin.green
    case .gray: Catppuccin.gray
    }
  }
}

private enum Catppuccin {
  static let amber = Color(light: 0xFE640B, dark: 0xFAB387)
  static let red = Color(light: 0xD20F39, dark: 0xF38BA8)
  static let pink = Color(light: 0xEA76CB, dark: 0xF5C2E7)
  static let purple = Color(light: 0x8839EF, dark: 0xCBA6F7)
  static let indigo = Color(light: 0x7287FD, dark: 0xB4BEFE)
  static let blue = Color(light: 0x1E66F5, dark: 0x89B4FA)
  static let teal = Color(light: 0x179299, dark: 0x94E2D5)
  static let green = Color(light: 0x40A02B, dark: 0xA6E3A1)
  static let gray = Color(light: 0x7C7F93, dark: 0x9399B2)
}

extension UIColor {
  convenience init(hex: UInt32, alpha: CGFloat) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }
}

/// Google Sans Flex for text and Google Sans Code for code (Resources/Fonts, made by make-fonts.py), at
/// iOS's sizes for each text style so they grow with Dynamic Type as the system's do.
enum Typeface {
  @MainActor
  static func size(_ style: Font.TextStyle) -> CGFloat {
    let size: CGFloat =
      switch style {
      case .largeTitle: 34
      case .title: 28
      case .title2: 22
      case .title3: 20
      case .callout: 16
      case .subheadline: 15
      case .footnote: 13
      case .caption: 12
      case .caption2: 11
      default: 17
      }
    #if targetEnvironment(macCatalyst)
      return size * TextSize.shared.scale
    #else
      return size
    #endif
  }

  static func sans(_ weight: Font.Weight) -> String {
    switch weight {
    case .medium: "GoogleSansFlex-Medium"
    case .semibold: "GoogleSansFlex-SemiBold"
    case .bold, .heavy, .black: "GoogleSansFlex-Bold"
    default: "GoogleSansFlex-Regular"
    }
  }

  static func code(_ weight: Font.Weight) -> String {
    switch weight {
    case .semibold, .bold, .heavy, .black: "GoogleSansCode-Bold"
    default: "GoogleSansCode-Regular"
    }
  }

  /// Bars and segmented controls are UIKit's, so they're given the fonts here.
  @MainActor
  static func applyToUIKit() {
    func font(_ weight: Font.Weight, _ size: CGFloat, _ style: UIFont.TextStyle) -> UIFont? {
      UIFont(name: sans(weight), size: size).map { UIFontMetrics(forTextStyle: style).scaledFont(for: $0) }
    }
    guard let title = font(.medium, 17, .headline), let large = font(.medium, 34, .largeTitle),
      let item = font(.medium, 17, .body), let segment = font(.medium, 13, .footnote)
    else { return }
    let bar = UINavigationBar.appearance()
    bar.titleTextAttributes = [.font: title]
    bar.largeTitleTextAttributes = [.font: large]
    for state: UIControl.State in [.normal, .highlighted, .disabled] {
      UIBarButtonItem.appearance().setTitleTextAttributes([.font: item], for: state)
    }
    for state: UIControl.State in [.normal, .selected] {
      UISegmentedControl.appearance().setTitleTextAttributes([.font: segment], for: state)
    }
  }
}

#if targetEnvironment(macCatalyst)
  /// A Mac has no Dynamic Type, so View → Make Text Bigger and Smaller size the text instead. The views
  /// that read it while they draw draw again when it changes.
  @MainActor @Observable
  final class TextSize {
    static let shared = TextSize()
    private static let steps: [CGFloat] = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5]
    private static let key = "textSize"

    private(set) var scale: CGFloat = {
      let saved = CGFloat(UserDefaults.standard.double(forKey: key))
      return steps.contains(saved) ? saved : 1
    }()

    func step(_ by: Int) {
      let i = (Self.steps.firstIndex(of: scale) ?? 2) + by
      guard Self.steps.indices.contains(i) else { return }
      set(Self.steps[i])
    }

    func reset() { set(1) }

    private func set(_ value: CGFloat) {
      scale = value
      UserDefaults.standard.set(Double(value), forKey: Self.key)
    }
  }
#endif

extension Font {
  /// Google Sans Flex in place of `.body`, `.footnote` and the rest. A headline is medium, as
  /// Material's titles are.
  @MainActor
  static func sans(_ style: TextStyle = .body, _ weight: Weight? = nil) -> Font {
    let face = Typeface.sans(weight ?? (style == .headline ? .medium : .regular))
    return .custom(face, size: Typeface.size(style), relativeTo: style)
  }

  /// Google Sans Code, for code and what's typed as it.
  @MainActor
  static func code(_ style: TextStyle = .body, _ weight: Weight = .regular) -> Font {
    .custom(Typeface.code(weight), size: Typeface.size(style), relativeTo: style)
  }
}

extension Animation {
  /// Expressive's spatial springs (damping 0.8, stiffness 380; fast 0.6, 800), for what moves or changes
  /// shape.
  static let expressive = Animation.spring(response: 0.32, dampingFraction: 0.8)
  static let expressiveFast = Animation.spring(response: 0.22, dampingFraction: 0.6)
}

/// Expressive's buttons, for those in what you read. A pill that squares off while it's pressed, as on the
/// web; a destructive one's label is red. `chosen` is a toggle that's on: filled, and squared off.
struct MaterialButtonStyle: ButtonStyle {
  enum Kind { case filled, tonal, outlined, chosen }
  var kind: Kind

  func makeBody(configuration: Configuration) -> some View {
    MaterialButtonBody(
      kind: kind, label: configuration.label, pressed: configuration.isPressed,
      destructive: configuration.role == .destructive)
  }
}

extension ButtonStyle where Self == MaterialButtonStyle {
  static func material(_ kind: MaterialButtonStyle.Kind) -> MaterialButtonStyle { MaterialButtonStyle(kind: kind) }
}

private struct MaterialButtonBody: View {
  let kind: MaterialButtonStyle.Kind
  let label: ButtonStyleConfiguration.Label
  let pressed: Bool
  let destructive: Bool
  @Environment(\.isEnabled) private var enabled
  @Environment(\.controlSize) private var size
  @ScaledMetric(relativeTo: .subheadline) private var scale: CGFloat = 1
  @State private var hovered = false

  private var small: Bool { size == .small || size == .mini }
  private var height: CGFloat { (small ? 32 : size == .large || size == .extraLarge ? 48 : 40) * scale }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: pressed ? 8 : kind == .chosen ? 12 : height / 2, style: .continuous)
    label
      .font(.sans(small ? .footnote : .subheadline, .medium))
      .multilineTextAlignment(.center)
      .padding(.horizontal, small ? 12 : 16)
      .padding(.vertical, 6)
      .frame(minHeight: height)
      .foregroundStyle(enabled ? foreground : Color.text.opacity(0.38))
      .background(fill, in: shape)
      .overlay {
        if kind == .outlined { shape.strokeBorder(Color.line) }
      }
      // Material's state layer: the label's colour over the fill under the pointer, and more while it's pressed.
      .overlay { shape.fill(foreground.opacity(pressed ? 0.12 : hovered && enabled ? 0.08 : 0)) }
      .contentShape(shape)
      .onHover { hovered = $0 }
      .animation(.expressiveFast, value: pressed)
      .animation(.expressive, value: kind)
  }

  private var fill: Color {
    switch kind {
    case .filled, .chosen, .tonal:
      guard enabled else { return Color.text.opacity(0.12) }
      return kind == .tonal ? .tonal : .brand
    case .outlined: return .clear
    }
  }

  private var foreground: Color {
    switch kind {
    case .filled, .chosen: .onBrand
    case .tonal: destructive ? .danger : .text
    case .outlined: destructive ? .danger : .text2
    }
  }
}

/// A Form as Expressive's segmented list, as on the web: each row its own tile, 2 pt apart, with small
/// corners inside and the section's large ones outside.
struct TiledForm<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    Form { content.tiles() }.tiledPage()
  }
}

/// A List as Expressive's segmented list, like `TiledForm`.
struct TiledList<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    List { content.tiles() }.tiledPage()
  }
}

extension View {
  /// On a Form's or List's rows, or the sections holding them.
  func tiles(_ fill: Color = .surface1) -> some View {
    listRowBackground(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(fill).padding(.vertical, 1))
      .listRowSeparator(.hidden)
  }

  /// On a Form or List whose rows are tiles: the page's surface between them.
  func tiledPage() -> some View {
    scrollContentBackground(.hidden).background(Color.surface)
  }

  /// A text field outside a form, filled as Material's are.
  func materialField() -> some View {
    textFieldStyle(.plain)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(Color.surface2, in: .rect(cornerRadius: 12, style: .continuous))
  }
}
