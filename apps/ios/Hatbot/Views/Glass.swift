// Liquid Glass on iOS 26 and later, with the closest older look on iOS 18–25. Glass is for
// controls and bars that float over content; messages and screenshots stay solid.
import SwiftUI

extension View {
  /// A floating surface: glass, or a material with a hairline border before iOS 26.
  @ViewBuilder
  func glassSurface(in shape: some Shape, interactive: Bool = false) -> some View {
    if #available(iOS 26, *) {
      glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    } else {
      background(.regularMaterial, in: shape)
        .overlay(shape.stroke(Color(uiColor: .separator), lineWidth: 0.5))
    }
  }

  /// A glass button; `prominent` fills it with the tint.
  @ViewBuilder
  func glassButton(prominent: Bool = false) -> some View {
    if #available(iOS 26, *) {
      if prominent { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
    } else {
      if prominent { buttonStyle(.borderedProminent) } else { buttonStyle(.bordered) }
    }
  }

  /// Controls pinned to an edge of a scroll view. On iOS 26 the content scrolls under them and
  /// fades at the edge; before, they sit on a bar.
  @ViewBuilder
  func edgeBar<C: View>(_ edge: VerticalEdge, @ViewBuilder content: () -> C) -> some View {
    let bar = content()
    if #available(iOS 26, *) {
      safeAreaBar(edge: edge) { bar }
    } else {
      safeAreaInset(edge: edge, spacing: 0) { bar.background(.bar) }
    }
  }

  /// Groups glass shapes so they blend and morph together on iOS 26.
  @ViewBuilder
  func glassGroup(spacing: CGFloat? = nil) -> some View {
    if #available(iOS 26, *) {
      GlassEffectContainer(spacing: spacing) { self }
    } else {
      self
    }
  }

  /// The tab bar shrinks while you scroll down, on iOS 26 and later.
  @ViewBuilder
  func minimizingTabBar() -> some View {
    if #available(iOS 26, *) {
      tabBarMinimizeBehavior(.onScrollDown)
    } else {
      self
    }
  }
}
