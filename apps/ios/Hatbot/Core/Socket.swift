import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif
#if canImport(Network)
  import Network
#endif

@MainActor
final class Socket {
  enum Message {
    case text(String)
    case data(Data)
  }

  /// The first message counts as open: the event stream always starts with `paused`, the live view with a frame.
  var onOpen: (_ reconnected: Bool) -> Void = { _ in }
  var onMessage: (Message) -> Void = { _ in }
  var onClose: () -> Void = {}
  /// The brain turned the token away at the handshake; the socket stops.
  var onUnauthorized: () -> Void = {}

  private static let pongWait: Duration = .seconds(10)

  private let make: () -> URLSessionWebSocketTask
  private let maxDelay: Double
  private var ws: URLSessionWebSocketTask?
  private var loop: Task<Void, Never>?
  private var wait: Task<Void, Never>?
  private var retry = 0
  private var pongs = 0
  /// Kept across stop and start: opening again after the app was in the background is a reconnect,
  /// so what was missed meanwhile gets loaded.
  private var everOpened = false
  #if canImport(Network)
    private var monitor: NWPathMonitor?
    /// The monitor's first update is the network as it is now, which the socket is already trying.
    private var networkSeen = false
  #endif

  init(maxDelay: Double = 30, make: @escaping () -> URLSessionWebSocketTask) {
    self.make = make
    self.maxDelay = maxDelay
  }

  var running: Bool { loop != nil }

  func start() {
    guard loop == nil else { return }
    loop = Task { [weak self] in await self?.run() }
    watchNetwork()
  }

  func stop() {
    loop?.cancel()
    loop = nil
    ws?.cancel(with: .normalClosure, reason: nil)
    ws = nil
    #if canImport(Network)
      monitor?.cancel()
      monitor = nil
    #endif
  }

  func send(_ text: String) {
    ws?.send(.string(text)) { _ in }
  }

  /// A socket that's open or opening is checked instead: one that went quiet doesn't say so.
  func retryNow() {
    guard loop != nil else { return }
    retry = 0
    if let wait {
      wait.cancel()
    } else if let ws {
      check(ws)
    }
  }

  func opened() -> Bool {
    defer { everOpened = true }
    return everOpened
  }

  /// Pings, and gives the socket up when the pong doesn't come in time: a connection that went quiet, on
  /// a network that's gone or through a proxy that dropped it, doesn't fail, it just never answers.
  private func check(_ ws: URLSessionWebSocketTask) {
    let before = pongs
    ws.sendPing { error in
      if error != nil {
        ws.cancel(with: .goingAway, reason: nil)
      } else {
        Task { @MainActor in self.pongs += 1 }
      }
    }
    Task {
      try? await Task.sleep(for: Self.pongWait)
      if pongs == before && self.ws === ws { ws.cancel(with: .goingAway, reason: nil) }
    }
  }

  private func watchNetwork() {
    #if canImport(Network)
      let monitor = NWPathMonitor()
      networkSeen = false
      monitor.pathUpdateHandler = { [weak self] path in
        let up = path.status == .satisfied
        MainActor.assumeIsolated { self?.networkChanged(up: up) }
      }
      monitor.start(queue: .main)
      self.monitor = monitor
    #endif
  }

  #if canImport(Network)
    private func networkChanged(up: Bool) {
      defer { networkSeen = true }
      if networkSeen && up { retryNow() }
    }
  #endif

  private func run() async {
    retry = 0
    while !Task.isCancelled {
      let ws = make()
      self.ws = ws
      ws.resume()
      // Proxies drop idle sockets, and a dead one only shows when a ping goes unanswered.
      let pinger = Task {
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(25))
          if !Task.isCancelled { check(ws) }
        }
      }
      var open = false
      do {
        while !Task.isCancelled {
          let message = try await ws.receive()
          if !open {
            open = true
            retry = 0
            onOpen(opened())
          }
          switch message {
          case let .string(text): onMessage(.text(text))
          case let .data(data): onMessage(.data(data))
          @unknown default: break
          }
        }
      } catch {}
      pinger.cancel()
      ws.cancel(with: .goingAway, reason: nil)
      if open { onClose() }
      if Task.isCancelled { break }
      if !open, (ws.response as? HTTPURLResponse)?.statusCode == 401 {
        loop = nil
        self.ws = nil
        onUnauthorized()
        break
      }
      let delay = min(maxDelay, pow(2, Double(retry)))
      retry += 1
      let wait = Task<Void, Never> { try? await Task.sleep(for: .seconds(delay)) }
      self.wait = wait
      await withTaskCancellationHandler { await wait.value } onCancel: { wait.cancel() }
      if self.wait == wait { self.wait = nil }
    }
  }
}
