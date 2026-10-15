// A WebSocket to the brain that reconnects with backoff until it's stopped.
import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
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

  private let make: () -> URLSessionWebSocketTask
  private let maxDelay: Double
  private var ws: URLSessionWebSocketTask?
  private var loop: Task<Void, Never>?
  /// Kept across stop and start: opening again after the app was in the background is a reconnect,
  /// so what was missed meanwhile gets loaded.
  private var everOpened = false

  init(maxDelay: Double = 30, make: @escaping () -> URLSessionWebSocketTask) {
    self.make = make
    self.maxDelay = maxDelay
  }

  var running: Bool { loop != nil }

  func start() {
    guard loop == nil else { return }
    loop = Task { [weak self] in await self?.run() }
  }

  func stop() {
    loop?.cancel()
    loop = nil
    ws?.cancel(with: .normalClosure, reason: nil)
    ws = nil
  }

  func send(_ text: String) {
    ws?.send(.string(text)) { _ in }
  }

  /// Whether this open is a reconnect.
  func opened() -> Bool {
    defer { everOpened = true }
    return everOpened
  }

  private func run() async {
    var retry = 0
    while !Task.isCancelled {
      let ws = make()
      self.ws = ws
      ws.resume()
      // Proxies drop idle sockets, and a dead one only shows when a ping fails.
      let pinger = Task {
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(25))
          ws.sendPing { error in
            if error != nil { ws.cancel(with: .goingAway, reason: nil) }
          }
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
      let delay = min(maxDelay, pow(2, Double(retry)))
      retry += 1
      try? await Task.sleep(for: .seconds(delay))
    }
  }
}
