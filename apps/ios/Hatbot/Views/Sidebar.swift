// The sections, in a drawer under the left edge, so chat gets the whole screen. The section slides
// aside to show it, following your finger: swipe in from the left edge, or tap the button at the
// top left of each section, which counts what needs you.
import SwiftUI

enum AppTab: Hashable, CaseIterable {
  case chat, tasks, live, memory, settings

  var title: String {
    switch self {
    case .chat: "Chat"
    case .tasks: "Tasks"
    case .live: "Live"
    case .memory: "Memory"
    case .settings: "Settings"
    }
  }

  var icon: String {
    switch self {
    case .chat: "bubble.left.and.bubble.right"
    case .tasks: "checklist"
    case .live: "display"
    case .memory: "book"
    case .settings: "gearshape"
    }
  }
}

extension EnvironmentValues {
  @Entry var openSidebar: (() -> Void)?
  /// A section's first page tells the drawer when it shows, so the edge swipe stays the back
  /// gesture on the pages pushed over it.
  @Entry var sidebarRoot: ((Bool) -> Void)?
}

extension View {
  /// The button that opens the sidebar, on a section's first page.
  func sidebarButton() -> some View { modifier(SidebarButton()) }
}

private struct SidebarButton: ViewModifier {
  @Environment(\.openSidebar) private var openSidebar
  @Environment(\.sidebarRoot) private var sidebarRoot
  @Environment(AppStore.self) private var store

  func body(content: Content) -> some View {
    content
      .onAppear { sidebarRoot?(true) }
      .onDisappear { sidebarRoot?(false) }
      .toolbar {
        if let openSidebar {
          ToolbarItem(placement: .topBarLeading) {
            Button(action: openSidebar) {
              Image(systemName: "line.3.horizontal")
                .overlay(alignment: .topTrailing) {
                  if store.needsYou > 0 { Count(n: store.needsYou).offset(x: 10, y: -8) }
                }
            }
            .accessibilityLabel(store.needsYou > 0 ? "Menu, \(store.needsYou) need you" : "Menu")
          }
        }
      }
  }
}

private struct Count: View {
  let n: Int

  var body: some View {
    Text("\(n)")
      .font(.caption2.weight(.semibold).monospacedDigit())
      .foregroundStyle(.white)
      .padding(.horizontal, 5)
      .frame(minWidth: 18, minHeight: 18)
      .background(Color.attention, in: .capsule)
  }
}

struct Sidebar<Content: View>: View {
  @Binding var tab: AppTab
  @Binding var open: Bool
  @ViewBuilder var content: Content
  @Environment(AppStore.self) private var store
  @GestureState(resetTransaction: Transaction(animation: .snappy)) private var drag: CGFloat = 0
  @State private var roots = 0

  var body: some View {
    GeometryReader { geo in
      let width = min(300, geo.size.width * 0.82)
      let shown = min(1, max(0, (open ? 1 : 0) + drag / width))
      ZStack(alignment: .leading) {
        content
          .environment(\.openSidebar) { setOpen(true) }
          .environment(\.sidebarRoot) { roots = max(0, roots + ($0 ? 1 : -1)) }
          .overlay {
            Color.black.opacity(0.25 * shown)
              .ignoresSafeArea()
              .allowsHitTesting(open)
              .onTapGesture { setOpen(false) }
          }
          .overlay(alignment: .leading) {
            if !open && roots > 0 {
              Color.clear
                .frame(width: 16)
                .contentShape(.rect)
                .ignoresSafeArea()
                .gesture(swipe(width))
            }
          }
          .accessibilityHidden(open)
          .offset(x: shown * width)
        panel
          .frame(width: width)
          .offset(x: (shown - 1) * width)
          .accessibilityHidden(!open)
          .accessibilityAddTraits(.isModal)
          .accessibilityAction(.escape) { setOpen(false) }
      }
      .gesture(swipe(width), including: open ? .all : .subviews)
    }
  }

  /// Follows the finger, then settles open or shut by where the throw would land. Measured on the
  /// screen, since the section moves under the finger.
  private func swipe(_ width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 10, coordinateSpace: .global)
      .updating($drag) { value, state, _ in state = value.translation.width }
      .onEnded { value in
        setOpen((open ? width : 0) + value.predictedEndTranslation.width > width / 2)
      }
  }

  private var panel: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(AppTab.allCases, id: \.self) { t in
        Button {
          tab = t
          setOpen(false)
        } label: {
          HStack(spacing: 14) {
            Image(systemName: t.icon).frame(width: 26)
            Text(t.title)
            Spacer()
            if t == .tasks && store.needsYou > 0 { Count(n: store.needsYou) }
          }
          .font(.body.weight(t == tab ? .semibold : .regular))
          .foregroundStyle(t == tab ? Color.brand : .primary)
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .background(t == tab ? Color.brand.opacity(0.14) : .clear, in: .capsule)
          .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(t == tab ? .isSelected : [])
      }
      Spacer()
    }
    .padding(.horizontal, 10)
    .padding(.top, 8)
    .frame(maxHeight: .infinity)
    .background(Color(uiColor: .secondarySystemBackground).ignoresSafeArea())
  }

  private func setOpen(_ value: Bool) {
    withAnimation(.snappy) { open = value }
  }
}
