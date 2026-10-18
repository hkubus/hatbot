// The desktop's live view (PLAN.md §10.5): JPEG frames over a WebSocket. Watch-only until you take
// over; then a tap clicks, a drag drags, a long press right-clicks, two fingers scroll, and the
// Keyboard button types. Pinching zooms in, and moving the pinch moves around; watching, one finger
// moves around a zoomed screen and a double tap zooms back out. On its tab in landscape the screen
// takes the whole height, with the controls beside it.
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
  /// On its own tab: in landscape the screen takes the whole height and the bars go.
  var fullScreen = false
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var phase
  @Environment(\.verticalSizeClass) private var vertical
  @Environment(\.sectionShown) private var sectionShown
  @State private var feed = LiveFeed()
  /// On screen: not under a page pushed over it.
  @State private var visible = false
  @State private var typing = false
  @State private var error: String?
  @State private var zoom = Zoom()

  private var landscape: Bool { fullScreen && sectionShown && vertical == .compact }
  /// Frames come only while you can see them: not under another page, in a hidden section or with the
  /// app in the background.
  private var streaming: Bool { visible && sectionShown && phase != .background }

  var body: some View {
    let control = store.desktop?.control == .owner
    Group {
      if landscape {
        HStack(alignment: .top, spacing: 12) {
          screen(control: control, online: store.desktop?.online ?? true)
            // The scroll view's height, less the padding.
            .containerRelativeFrame(.vertical) { height, _ in max(height - 24, 100) }
          VStack(alignment: .leading, spacing: 12) {
            controls(control: control)
            Spacer(minLength: 0)
          }
          .frame(width: 220)
        }
        .padding(12)
      } else {
        VStack(alignment: .leading, spacing: 12) {
          controls(control: control, screen: true)
        }
        .padding()
      }
    }
    .toolbar(landscape ? .hidden : .automatic, for: .navigationBar)
    .statusBarHidden(landscape)
    .onAppear { visible = true }
    .onDisappear { visible = false }
    .onChange(of: streaming, initial: true) { _, on in
      if on { feed.start(store) } else { feed.stop() }
    }
    .onChange(of: control) { _, control in if !control { typing = false } }
    // Taking over and handing back, felt once even when another section keeps a live view too.
    .sensoryFeedback(.impact(weight: .medium), trigger: control) { _, _ in sectionShown }
    // The screen changes size.
    .onChange(of: landscape) { zoom = Zoom() }
  }

  /// The banner, the buttons and the task; with `screen`, the screen goes between the banner and the buttons.
  @ViewBuilder
  private func controls(control: Bool, screen showsScreen: Bool = false) -> some View {
    let desktop = store.desktop
    Group {
      if control {
        banner(icon: "hand.raised.fill", text: "You're in control. Hatbot is paused.") {
          Button("Hand back") { run { try await store.handback() } }.glassButton(prominent: true)
        }
      } else if let request = desktop?.request {
        banner(icon: "hand.raised.fill", text: "**Hatbot needs you:** \(request.reason)") {
          Button("Take over") { run { try await store.takeover() } }.glassButton(prominent: true)
        }
      }

      if showsScreen { screen(control: control, online: desktop?.online ?? true) }

      HStack {
        if control {
          Button("Keyboard", systemImage: "keyboard") { typing.toggle() }
            .glassButton(prominent: typing)
            .tint(.attention)
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
        Image(uiImage: frame).resizable().interpolation(zoom.scale > 1 ? .high : .medium)
          .aspectRatio(contentMode: .fit)
          .scaleEffect(zoom.scale, anchor: .topLeading)
          .offset(x: zoom.offset.x, y: zoom.offset.y)
      }
      if !online || feed.conn != .live {
        Text(!online || feed.conn == .offline ? "The desktop isn't answering." : "Connecting…")
          .font(.subheadline)
          .foregroundStyle(.white.opacity(0.8))
      }
      // Watching, it only zooms and moves around.
      TouchSurface(desktopSize: size, control: control, zoom: zoom, setZoom: { zoom = $0 }, send: { feed.send($0) })
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
    Task { await attempt($error) { try await action() } }
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
        ForEach((store.steps[taskId] ?? []).latestNoteOnly.suffix(6).reversed()) { step in
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
    .onAppear { store.ensureSteps(taskId) }
  }
}

/// Turns touches on the screen into the desktop's pointer events, in desktop pixels.
private struct TouchSurface: UIViewRepresentable {
  let desktopSize: CGSize
  /// You're in control: touches go to the desktop. Otherwise they only zoom and move around.
  let control: Bool
  let zoom: Zoom
  let setZoom: @MainActor (Zoom) -> Void
  let send: @MainActor (LiveInput) -> Void

  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.backgroundColor = .clear
    let c = context.coordinator
    let tap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tap))
    let doubleTap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.doubleTap))
    doubleTap.numberOfTapsRequired = 2
    let long = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.longPress))
    let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.pan))
    pan.maximumNumberOfTouches = 1
    let scroll = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.scroll))
    scroll.minimumNumberOfTouches = 2
    let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinch))
    for g in [tap, doubleTap, long, pan, scroll, pinch] as [UIGestureRecognizer] {
      view.addGestureRecognizer(g)
    }
    c.recognizers = (tap, doubleTap, long, pan, scroll)
    update(c)
    return view
  }

  func updateUIView(_ view: UIView, context: Context) {
    update(context.coordinator)
  }

  private func update(_ c: Coordinator) {
    c.parent = self
    if !c.pinching { c.zoom = zoom }
    guard let r = c.recognizers else { return }
    r.tap.isEnabled = control
    r.long.isEnabled = control
    r.scroll.isEnabled = control
    r.doubleTap.isEnabled = !control
    // Watching an unzoomed screen, a drag scrolls the page.
    r.pan.isEnabled = control || zoom.scale > 1
  }

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  @MainActor
  final class Coordinator: NSObject {
    var parent: TouchSurface
    var recognizers: (
      tap: UIGestureRecognizer, doubleTap: UIGestureRecognizer, long: UIGestureRecognizer,
      pan: UIGestureRecognizer, scroll: UIGestureRecognizer
    )?
    /// The zoom as the gestures see it; it's ahead of the view's while a pinch goes on.
    var zoom = Zoom()
    private(set) var pinching = false
    private var lastMove = Date.distantPast
    private var lastScroll = CGPoint.zero
    private var lastPinch = CGPoint.zero
    private var lastPan = CGPoint.zero

    init(parent: TouchSurface) { self.parent = parent }

    /// Where a touch is on the desktop, in its pixels, through the zoom.
    private func point(_ g: UIGestureRecognizer) -> (x: Double, y: Double) {
      guard let view = g.view, view.bounds.width > 0, view.bounds.height > 0 else { return (0, 0) }
      let p = zoom.unzoomed(g.location(in: view))
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

    @objc func doubleTap(_ g: UITapGestureRecognizer) {
      guard let view = g.view else { return }
      let p = g.location(in: view)
      zoom = zoom.scale > 1 ? Zoom() : zoom.zoomed(by: 2.5, at: p, in: view.bounds.size)
      parent.setZoom(zoom)
    }

    @objc func pinch(_ g: UIPinchGestureRecognizer) {
      guard let view = g.view else { return }
      let p = g.location(in: view)
      switch g.state {
      case .began:
        pinching = true
        lastPinch = p
      case .changed:
        // Two fingers can pinch and move together; lifting one jumps the middle, so that's skipped.
        let pan = g.numberOfTouches < 2 ? .zero : CGPoint(x: p.x - lastPinch.x, y: p.y - lastPinch.y)
        zoom = zoom.zoomed(by: g.scale, at: p, pan: pan, in: view.bounds.size)
        g.scale = 1
        lastPinch = p
        parent.setZoom(zoom)
      default:
        pinching = false
        parent.setZoom(zoom)
      }
    }

    @objc func pan(_ g: UIPanGestureRecognizer) {
      guard parent.control else { return move(g) }
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

    /// Watching: moves around the zoomed screen.
    private func move(_ g: UIPanGestureRecognizer) {
      guard let view = g.view else { return }
      let t = g.translation(in: view)
      if g.state == .began { lastPan = .zero }
      zoom = zoom.moved(by: CGPoint(x: t.x - lastPan.x, y: t.y - lastPan.y), in: view.bounds.size)
      lastPan = t
      parent.setZoom(zoom)
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
      _ = view.resignFirstResponder()
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
