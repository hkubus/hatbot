// The sections, in a sidebar that slides in from the left, so chat gets the whole screen. The
// button that opens it sits at the top left of each section and counts what needs you.
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
}

extension View {
  /// The button that opens the sidebar, on a section's first page.
  func sidebarButton() -> some View { modifier(SidebarButton()) }
}

private struct SidebarButton: ViewModifier {
  @Environment(\.openSidebar) private var openSidebar
  @Environment(AppStore.self) private var store

  func body(content: Content) -> some View {
    content.toolbar {
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

struct Sidebar: View {
  @Binding var tab: AppTab
  @Binding var open: Bool
  @Environment(AppStore.self) private var store
  @GestureState private var drag: CGFloat = 0

  var body: some View {
    ZStack(alignment: .leading) {
      if open {
        Color.black.opacity(0.2)
          .ignoresSafeArea()
          .onTapGesture(perform: close)
          .accessibilityHidden(true)
          .transition(.opacity)
        panel
          .offset(x: min(0, drag))
          .gesture(
            DragGesture()
              .updating($drag) { value, state, _ in state = value.translation.width }
              .onEnded { value in
                if value.predictedEndTranslation.width < -100 { close() }
              }
          )
          .accessibilityAddTraits(.isModal)
          .accessibilityAction(.escape, close)
          .transition(.move(edge: .leading))
      }
    }
  }

  private var panel: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(AppTab.allCases, id: \.self) { t in
        Button {
          tab = t
          close()
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
    .padding(10)
    .padding(.top, 8)
    .frame(width: 270)
    .frame(maxHeight: .infinity)
    .glassSurface(in: .rect(cornerRadius: 32))
    .padding(8)
  }

  private func close() {
    withAnimation(.snappy) { open = false }
  }
}
