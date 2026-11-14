import SwiftUI
import UIKit

enum AppTab: Hashable, CaseIterable {
  case chat, search, tasks, todo, boxes, live, memory, settings

  var title: String {
    switch self {
    case .chat: "Chat"
    case .search: "Search"
    case .tasks: "Tasks"
    case .todo: "To-do"
    case .boxes: "Boxes"
    case .live: "Live"
    case .memory: "Memory"
    case .settings: "Settings"
    }
  }

  var icon: String {
    switch self {
    case .chat: "bubble.left.and.bubble.right"
    case .search: "magnifyingglass"
    case .tasks: "checklist"
    case .todo: "checkmark.square"
    case .boxes: "shippingbox"
    case .live: "display"
    case .memory: "book"
    case .settings: "gearshape"
    }
  }

  /// The plugin it's part of: it hides while that's off, as on the web.
  var plugin: String? {
    switch self {
    case .boxes: "boxes"
    case .live: "desktop"
    default: nil
    }
  }
}

extension EnvironmentValues {
  @Entry var openSidebar: (() -> Void)?
  /// A section's first page tells the drawer when it shows, so the edge swipe stays the back
  /// gesture on the pages pushed over it.
  @Entry var sidebarRoot: ((Bool) -> Void)?
  /// Whether this section is the one showing. The others stay, hidden, with what you'd typed in them.
  @Entry var sectionShown = true
}

extension View {
  func sidebarButton() -> some View { modifier(SidebarButton()) }
}

private struct SidebarButton: ViewModifier {
  @Environment(\.openSidebar) private var openSidebar
  @Environment(\.sidebarRoot) private var sidebarRoot
  @Environment(AppStore.self) private var store

  func body(content: Content) -> some View {
    content
      #if targetEnvironment(macCatalyst)
        // In the window's toolbar, as a Mac app's is: a large title there sits against the sidebar.
        .navigationBarTitleDisplayMode(.inline)
      #endif
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

struct Count: View {
  let n: Int

  var body: some View {
    Text("\(n)")
      .font(.sans(.caption2, .semibold).monospacedDigit())
      .foregroundStyle(Color.onBrand)
      .padding(.horizontal, 5)
      .frame(minWidth: 18, minHeight: 18)
      .background(Color.brand, in: .capsule)
  }
}

struct Sidebar<Content: View>: View {
  @Binding var tab: AppTab
  @Binding var open: Bool
  /// The open section shows its first page, where an edge swipe opens the drawer instead of going back.
  var atRoot: Bool
  @ViewBuilder var content: Content
  @Environment(AppStore.self) private var store
  @GestureState(resetTransaction: Transaction(animation: .snappy)) private var drag: CGFloat = 0
  @State private var edge: CGFloat = 0
  @State private var newBot = false
  @State private var newGroup = false
  @Environment(\.horizontalSizeClass) private var width
  @Environment(\.verticalSizeClass) private var height

  /// Beside the sections on an iPad's full width. A drawer otherwise, in landscape on the largest
  /// iPhones too, where the live desktop needs the width.
  private var docked: Bool { width == .regular && height == .regular }

  /// One layout, docked or not, so the sections keep what they hold when the phone turns.
  var body: some View {
    GeometryReader { geo in
      let panelWidth = docked ? 300 : min(300, geo.size.width * 0.82)
      let shown = docked ? 0 : min(1, max(0, (open ? 1 : 0) + (drag + edge) / panelWidth))
      let openSidebar: (() -> Void)? = docked ? nil : { setOpen(true) }
      ZStack(alignment: .leading) {
        content
          .environment(\.openSidebar, openSidebar)
          .overlay {
            Color.black.opacity(0.25 * shown)
              .ignoresSafeArea()
              .allowsHitTesting(open && !docked)
              .onTapGesture { setOpen(false) }
          }
          .gesture(
            EdgePan(enabled: !docked && !open && atRoot, moved: { edge = max(0, $0) }) { landing in
              withAnimation(.snappy) {
                edge = 0
                open = landing > panelWidth / 2
              }
            }
          )
          .accessibilityHidden(open && !docked)
          .padding(.leading, docked ? panelWidth : 0)
          .offset(x: shown * panelWidth)
        panel
          .frame(width: panelWidth)
          .overlay(alignment: .trailing) {
            if docked { HStack(spacing: 0) { Divider() }.ignoresSafeArea() }
          }
          .offset(x: docked ? 0 : (shown - 1) * panelWidth)
          .accessibilityHidden(!open && !docked)
          .accessibilityAddTraits(docked ? [] : .isModal)
          .accessibilityAction(.escape) { setOpen(false) }
      }
      .gesture(swipe(panelWidth), including: open && !docked ? .all : .subviews)
    }
    // It would cover the drawer.
    .onChange(of: open) { _, open in if open { hideKeyboard() } }
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
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if store.conversations.isEmpty {
          row(AppTab.chat.title, icon: AppTab.chat.icon, selected: tab == .chat, count: store.unread.count) {
            tab = .chat
          }
        } else {
          ForEach(store.conversations) { c in
            let bot = c.kind == .direct ? c.botIds.first.flatMap { store.bots[$0] } : nil
            row(
              store.chatName(c), icon: bot?.icon.symbol ?? (c.kind == .group ? "person.3" : "bubble.left"),
              tint: bot?.color.color, selected: tab == .chat && c.id == store.listedChatId, count: c.unread
            ) {
              tab = .chat
              Task { await store.openConversation(c.id) }
            }
          }
          row("New bot", icon: "plus", selected: false, count: 0) { newBot = true }
          if store.botIds.count > 1 {
            row("New group", icon: "person.3", selected: false, count: 0) { newGroup = true }
          }
          Divider().overlay(Color.line).padding(.vertical, 8).padding(.horizontal, 16)
        }
        ForEach(AppTab.allCases.filter { t in t != .chat && t.plugin.map { store.pluginOn($0) } != false }, id: \.self) { t in
          row(t.title, icon: t.icon, selected: t == tab, count: t == .tasks ? store.needsYou : 0) {
            tab = t
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.top, 8)
    }
    // As on the web. A Mac with a mouse would show `.hidden` ones anyway.
    .scrollIndicators(.never)
    .frame(maxHeight: .infinity)
    // Over the page, Material's modal drawer, with its outer corners rounded.
    .background(
      UnevenRoundedRectangle(
        bottomTrailingRadius: docked ? 0 : 16, topTrailingRadius: docked ? 0 : 16, style: .continuous
      )
      .fill(Color.surface1)
      .ignoresSafeArea())
    .sheet(isPresented: $newBot) {
      NavigationStack {
        BotView(id: nil) { bot in
          newBot = false
          tab = .chat
          setOpen(false)
          if let c = store.conversations.first(where: { $0.kind == .direct && $0.botIds.first == bot.id }) {
            Task { await store.openConversation(c.id) }
          }
        }
        .routes()
      }
    }
    .sheet(isPresented: $newGroup) {
      NavigationStack {
        GroupView(id: nil) { c in
          newGroup = false
          tab = .chat
          setOpen(false)
          Task { await store.openConversation(c.id) }
        }
      }
    }
  }

  private func row(
    _ title: String, icon: String, tint: Color? = nil, selected: Bool, count: Int,
    action: @escaping () -> Void
  ) -> some View {
    DrawerItem(title: title, icon: icon, tint: tint, selected: selected, count: count) {
      action()
      setOpen(false)
    }
  }

  private func setOpen(_ value: Bool) {
    withAnimation(.snappy) { open = value }
  }
}

private struct DrawerItem: View {
  let title: String
  let icon: String
  let tint: Color?
  let selected: Bool
  let count: Int
  let action: () -> Void
  @State private var hovered = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Image(systemName: icon).frame(width: 26).foregroundStyle(tint ?? (selected ? Color.text : Color.text2))
        Text(title).lineLimit(1)
        Spacer()
        if count > 0 { Count(n: count) }
      }
      .font(.sans(.callout, .medium))
      .foregroundStyle(selected ? Color.text : Color.text2)
      .padding(.horizontal, 16)
      .frame(minHeight: 56)
      // Material's indicator, grown out from its middle, and its state layer under the pointer.
      .background {
        if selected {
          Capsule().fill(Color.brandSoft).transition(.scale(scale: 0.2).combined(with: .opacity))
        } else if hovered {
          Capsule().fill(Color.text2.opacity(0.08))
        }
      }
      .animation(.expressive, value: selected)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .onHover { hovered = $0 }
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// The drawer's swipe in from the left edge: UIKit's screen-edge pan, which leaves taps near the edge to
/// what's under them.
private struct EdgePan: UIGestureRecognizerRepresentable {
  var enabled: Bool
  var moved: (CGFloat) -> Void
  var ended: (CGFloat) -> Void

  func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
    let pan = UIScreenEdgePanGestureRecognizer()
    pan.edges = .left
    return pan
  }

  func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
    recognizer.isEnabled = enabled
  }

  func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
    let x = recognizer.translation(in: recognizer.view).x
    switch recognizer.state {
    case .began, .changed: moved(x)
    case .ended: ended(x + recognizer.velocity(in: recognizer.view).x * 0.2)
    default: ended(0)
    }
  }
}
