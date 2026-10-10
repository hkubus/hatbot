// The desktop's live view (PLAN.md §10.5): JPEG frames over a WebSocket. Watch-only until you take
// over; then a tap clicks, a drag drags, a long press right-clicks, two fingers scroll, and the
// Keyboard button types.
import SwiftUI
import UIKit

/// The frames, decoded off the main thread; frames that arrive while one decodes are skipped.
@MainActor
@Observable
final class LiveFeed {
  enum Conn { case connecting, live, offline }

  private(set) var frame: UIImage?
  private(set) var conn = Conn.connecting
  @ObservationIgnored private var socket: Socket?
  @ObservationIgnored private var decoding = false
  @ObservationIgnored private var next: Data?

  func start(_ store: AppStore) {
    guard socket == nil else { return }
    let socket = store.liveSocket()
    socket.onOpen = { [weak self] _ in self?.conn = .live }
    socket.onClose = { [weak self] in self?.conn = .offline }
    socket.onMessage = { [weak self] message in
      if case let .data(data) = message { self?.show(data) }
    }
    self.socket = socket
    socket.start()
  }

  func stop() {
    socket?.stop()
    socket = nil
    conn = .connecting
  }

  func send(_ input: LiveInput) {
    guard let data = try? JSONEncoder().encode(input) else { return }
    socket?.send(String(decoding: data, as: UTF8.self))
  }

  func key(_ name: String) {
    send(.key(name, down: true))
    send(.key(name, down: false))
  }

  private func show(_ data: Data) {
    if decoding {
      next = data
      return
    }
    decoding = true
    Task {
      let image = await Task.detached(priority: .userInitiated) { UIImage(data: data)?.preparingForDisplay() }.value
      if let image { frame = image }
      decoding = false
      if let pending = next {
        next = nil
        show(pending)
      }
    }
  }
}

struct LiveView: View {
  var taskId: Int?
  /// The task on the screen and its latest steps, under the view.
  var showsTask = true
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var feed = LiveFeed()
  @State private var typing = false
  @State private var error: String?

  var body: some View {
    let desktop = store.desktop
    let control = desktop?.control == .owner
    VStack(alignment: .leading, spacing: 12) {
      if control {
        banner(icon: "hand.raised.fill", text: "You're in control. Hatbot is paused.") {
          Button("Hand back") { run { try await store.handback() } }.glassButton(prominent: true)
        }
      } else if let request = desktop?.request {
        banner(icon: "hand.raised.fill", text: "**Hatbot needs you:** \(request.reason)") {
          Button("Take over") { run { try await store.takeover() } }.glassButton(prominent: true)
        }
      }

      screen(control: control, online: desktop?.online ?? true)

      HStack {
        if control {
          Button("Keyboard", systemImage: "keyboard") { typing.toggle() }
            .glassButton(prominent: typing)
        } else if desktop?.request == nil && desktop?.online == true {
          Button("Take over", systemImage: "hand.raised") { run { try await store.takeover() } }
            .glassButton()
            .tint(.attention)
        }
        Spacer()
      }
      .background { if control { KeyCatcher(active: $typing, send: { feed.key($0) }) } }

      if let error {
        Text(error).font(.footnote).foregroundStyle(.red)
      }
      if showsTask, let id = activeTaskId { ScreenTask(taskId: id) }
    }
    .padding()
    .onAppear { feed.start(store) }
    .onDisappear { feed.stop() }
    .onChange(of: phase) { _, phase in
      if phase == .active { feed.start(store) } else if phase == .background { feed.stop() }
    }
    .onChange(of: control) { _, control in if !control { typing = false } }
  }

  private var activeTaskId: Int? {
    taskId ?? store.desktop?.activeTaskId ?? store.desktop?.request?.taskId
  }

  private func banner<A: View>(icon: String, text: LocalizedStringKey, @ViewBuilder action: () -> A) -> some View {
    HStack(spacing: 10) {
      Image(systemName: icon).foregroundStyle(Color.attention)
      Text(text).font(.subheadline)
      Spacer(minLength: 0)
      action().controlSize(.small).tint(.attention)
    }
  }

  private func screen(control: Bool, online: Bool) -> some View {
    let size = feed.frame?.size ?? CGSize(width: 1280, height: 800)
    return ZStack {
      Rectangle().fill(Color.black)
      if let frame = feed.frame, online {
        Image(uiImage: frame).resizable().interpolation(.medium).aspectRatio(contentMode: .fit)
      }
      if !online || feed.conn != .live {
        Text(!online || feed.conn == .offline ? "The desktop isn't answering." : "Connecting…")
          .font(.subheadline)
          .foregroundStyle(.white.opacity(0.8))
      }
      if control {
        TouchSurface(desktopSize: size, send: { feed.send($0) })
      }
    }
    .aspectRatio(size.width / size.height, contentMode: .fit)
    .clipShape(.rect(cornerRadius: 10))
    .overlay {
      RoundedRectangle(cornerRadius: 10)
        .strokeBorder(control ? Color.attention : Color(uiColor: .separator), lineWidth: control ? 2 : 0.5)
    }
    .accessibilityLabel("The desktop")
  }

  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    error = nil
    Task {
      do { try await action() } catch { self.error = message(for: error) }
    }
  }
}

/// The task using the screen, and its last few steps.
private struct ScreenTask: View {
  let taskId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let task = store.tasks[taskId] {
        NavigationLink(value: Route.task(taskId)) {
          HStack {
            Text(task.title).font(.headline).foregroundStyle(.primary)
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
          }
        }
        .buttonStyle(.plain)
        Text(Format.taskLine(task, progress: store.taskProgress[taskId]))
          .font(.subheadline)
          .foregroundStyle(.secondary)
        ForEach((store.steps[taskId] ?? []).suffix(6).reversed()) { step in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(step.createdAt.timeText).monospacedDigit().foregroundStyle(.secondary)
            Text(step.detail.isEmpty ? step.name : step.detail)
              .foregroundStyle(step.kind == .approval || step.kind == .takeover ? Color.attention : .primary)
              .lineLimit(2)
          }
          .font(.footnote)
        }
      }
    }
    .onAppear { store.ensureTask(taskId) }
  }
}

/// Turns touches on the screen into the desktop's pointer events, in desktop pixels.
private struct TouchSurface: UIViewRepresentable {
  let desktopSize: CGSize
  let send: @MainActor (LiveInput) -> Void

  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.backgroundColor = .clear
    let c = context.coordinator
    view.addGestureRecognizer(UITapGestureRecognizer(target: c, action: #selector(Coordinator.tap)))
    let long = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.longPress))
    view.addGestureRecognizer(long)
    let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.pan))
    pan.maximumNumberOfTouches = 1
    view.addGestureRecognizer(pan)
    let scroll = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.scroll))
    scroll.minimumNumberOfTouches = 2
    view.addGestureRecognizer(scroll)
    return view
  }

  func updateUIView(_ view: UIView, context: Context) {
    context.coordinator.parent = self
  }

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  @MainActor
  final class Coordinator: NSObject {
    var parent: TouchSurface
    private var lastMove = Date.distantPast
    private var lastScroll = CGPoint.zero

    init(parent: TouchSurface) { self.parent = parent }

    private func point(_ g: UIGestureRecognizer) -> (x: Double, y: Double) {
      guard let view = g.view, view.bounds.width > 0, view.bounds.height > 0 else { return (0, 0) }
      let p = g.location(in: view)
      let x = min(max(p.x / view.bounds.width, 0), 1) * parent.desktopSize.width
      let y = min(max(p.y / view.bounds.height, 0), 1) * parent.desktopSize.height
      return (x.rounded(), y.rounded())
    }

    private func click(_ g: UIGestureRecognizer, button: Int) {
      let (x, y) = point(g)
      parent.send(.button(button, down: true, x: x, y: y))
      parent.send(.button(button, down: false, x: x, y: y))
    }

    @objc func tap(_ g: UITapGestureRecognizer) {
      click(g, button: 1)
    }

    @objc func longPress(_ g: UILongPressGestureRecognizer) {
      if g.state == .began { click(g, button: 3) }
    }

    @objc func pan(_ g: UIPanGestureRecognizer) {
      let (x, y) = point(g)
      switch g.state {
      case .began:
        parent.send(.button(1, down: true, x: x, y: y))
      case .changed:
        // About 20 moves a second, like the web view.
        guard Date().timeIntervalSince(lastMove) > 0.05 else { return }
        lastMove = Date()
        parent.send(.move(x: x, y: y))
      default:
        parent.send(.button(1, down: false, x: x, y: y))
      }
    }

    @objc func scroll(_ g: UIPanGestureRecognizer) {
      let t = g.translation(in: g.view)
      if g.state == .began { lastScroll = t }
      // Sent in wheel pixels like a browser's deltaY: desktop-agent turns every 50 into one notch.
      let dy = (lastScroll.y - t.y) * 2
      let dx = (lastScroll.x - t.x) * 2
      guard abs(dy) >= 50 || abs(dx) >= 50 else { return }
      let (x, y) = point(g)
      parent.send(abs(dy) >= abs(dx) ? .wheel(dx: 0, dy: dy, x: x, y: y) : .wheel(dx: dx, dy: 0, x: x, y: y))
      lastScroll = t
    }
  }
}

/// A hidden view that holds the keyboard while `active`, and sends each key to the desktop.
private struct KeyCatcher: UIViewRepresentable {
  @Binding var active: Bool
  let send: @MainActor (String) -> Void

  func makeUIView(context: Context) -> KeyView {
    let view = KeyView()
    view.send = send
    view.onResign = { active = false }
    return view
  }

  func updateUIView(_ view: KeyView, context: Context) {
    view.send = send
    view.onResign = { active = false }
    if active && !view.isFirstResponder {
      view.becomeFirstResponder()
    } else if !active && view.isFirstResponder {
      view.resignFirstResponder()
    }
  }

  final class KeyView: UIView, UIKeyInput {
    var send: @MainActor (String) -> Void = { _ in }
    var onResign: @MainActor () -> Void = {}

    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var keyboardType: UIKeyboardType = .asciiCapable

    override var canBecomeFirstResponder: Bool { true }
    var hasText: Bool { true }

    func insertText(_ text: String) {
      for ch in text {
        switch ch {
        case "\n": send("Enter")
        case "\t": send("Tab")
        default: send(String(ch))
        }
      }
    }

    func deleteBackward() { send("Backspace") }

    override func resignFirstResponder() -> Bool {
      let resigned = super.resignFirstResponder()
      if resigned { onResign() }
      return resigned
    }

    /// A hardware keyboard: named keys that UIKeyInput doesn't pass on.
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      var handled = false
      for press in presses {
        guard let key = press.key, let name = Self.named[key.keyCode] else { continue }
        send(name)
        handled = true
      }
      if !handled { super.pressesBegan(presses, with: event) }
    }

    private static let named: [UIKeyboardHIDUsage: String] = [
      .keyboardEscape: "Escape",
      .keyboardUpArrow: "ArrowUp",
      .keyboardDownArrow: "ArrowDown",
      .keyboardLeftArrow: "ArrowLeft",
      .keyboardRightArrow: "ArrowRight",
      .keyboardDeleteForward: "Delete",
      .keyboardHome: "Home",
      .keyboardEnd: "End",
      .keyboardPageUp: "PageUp",
      .keyboardPageDown: "PageDown",
    ]
  }
}
