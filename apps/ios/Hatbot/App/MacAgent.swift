#if targetEnvironment(macCatalyst)
  import Foundation
  import Observation

  /// Lets Hatbot use this Mac. The agent ships inside the app (hatbot-agent, from apps/desktop/agent,
  /// built by mac-agent.sh) and runs while you're signed in and Hatbot is open. It takes a line of JSON
  /// for each change and answers with a line of its state; closing its input stops it.
  @MainActor @Observable
  final class MacAgent {
    static let shared = MacAgent()

    struct State: Decodable, Equatable {
      struct Status: Decodable, Equatable {
        struct Screen: Decodable, Equatable {
          var output: String
        }
        var enabled: Bool
        var locked: Bool
        var ownerActive: Bool
        var paused: Bool
        /// The screen a task holds.
        var screen: Screen?
      }
      /// "connecting", "connected" or "offline".
      var connection: String
      var error: String?
      var status: Status
      /// macOS lets it control the Mac (Accessibility).
      var control: Bool
      /// macOS lets it see the screen (Screen Recording).
      var screen: Bool
    }

    private(set) var state: State?
    /// "Let Hatbot use this Mac", as you last left it. Only ever switched here.
    private(set) var enabled = UserDefaults.standard.bool(forKey: MacAgent.enabledKey)

    private static let enabledKey = "macAgentEnabled"
    private var signedIn: (server: URL, token: String)?
    private var child: (pid: pid_t, input: Int32)?

    /// Starts it for this sign-in, or stops it when there's none.
    func run(server: URL?, token: String?) {
      if signedIn?.server == server && signedIn?.token == token { return }
      stop()
      signedIn = server.flatMap { s in token.map { (s, $0) } }
      start()
    }

    func setEnabled(_ on: Bool) {
      enabled = on
      UserDefaults.standard.set(on, forKey: Self.enabledKey)
      send(["op": "enabled", "on": on])
    }

    func setPaused(_ on: Bool) { send(["op": on ? "pause" : "resume"]) }

    func stopTask() { send(["op": "stop_task"]) }

    private func start() {
      guard child == nil, let signedIn,
        let path = Bundle.main.url(forAuxiliaryExecutable: "hatbot-agent")?.path
      else { return }
      var toAgent: [Int32] = [0, 0]
      var fromAgent: [Int32] = [0, 0]
      guard pipe(&toAgent) == 0 else { return }
      guard pipe(&fromAgent) == 0 else {
        close(toAgent[0])
        close(toAgent[1])
        return
      }
      // A write to an agent that's gone fails instead of killing the app.
      _ = fcntl(toAgent[1], F_SETNOSIGPIPE, 1)
      var actions: posix_spawn_file_actions_t?
      posix_spawn_file_actions_init(&actions)
      posix_spawn_file_actions_adddup2(&actions, toAgent[0], 0)
      posix_spawn_file_actions_adddup2(&actions, fromAgent[1], 1)
      for fd in [toAgent[0], toAgent[1], fromAgent[0], fromAgent[1]] { posix_spawn_file_actions_addclose(&actions, fd) }
      var argv: [UnsafeMutablePointer<CChar>?] = [strdup(path), nil]
      var pid: pid_t = 0
      let spawned = posix_spawn(&pid, path, &actions, nil, &argv, environ)
      posix_spawn_file_actions_destroy(&actions)
      argv.forEach { free($0) }
      close(toAgent[0])
      close(fromAgent[1])
      guard spawned == 0 else {
        close(toAgent[1])
        close(fromAgent[0])
        return
      }
      child = (pid, toAgent[1])
      send(["brainUrl": signedIn.server.absoluteString, "token": signedIn.token, "enabled": enabled])
      let output = FileHandle(fileDescriptor: fromAgent[0], closeOnDealloc: true)
      Task.detached { [weak self] in
        let decoder = JSONDecoder()
        do {
          for try await line in output.bytes.lines {
            guard let s = try? decoder.decode(State.self, from: Data(line.utf8)) else { continue }
            await self?.update(s, from: pid)
          }
        } catch {}
        var status: Int32 = 0
        waitpid(pid, &status, 0)
        await self?.ended(pid)
      }
    }

    private func stop() {
      guard let child else { return }
      // Its input closing stops it.
      close(child.input)
      self.child = nil
      state = nil
    }

    private func update(_ s: State, from pid: pid_t) {
      if child?.pid == pid { state = s }
    }

    /// It stopped by itself: it's started again in a while.
    private func ended(_ pid: pid_t) {
      guard child?.pid == pid else { return }
      stop()
      Task {
        try? await Task.sleep(for: .seconds(5))
        start()
      }
    }

    private func send(_ message: [String: Any]) {
      guard let child, var line = try? JSONSerialization.data(withJSONObject: message) else { return }
      line.append(0x0A)
      _ = line.withUnsafeBytes { write(child.input, $0.baseAddress, $0.count) }
    }
  }
#endif
