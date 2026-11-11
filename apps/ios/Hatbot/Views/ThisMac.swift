#if targetEnvironment(macCatalyst)
  import SwiftUI
  import UIKit

  /// Settings' part for letting Hatbot use this Mac, as the desktop app's This computer page.
  struct ThisMacSections: View {
    private let agent = MacAgent.shared

    var body: some View {
      Section {
        Toggle("Let Hatbot use this Mac", isOn: Binding(get: { agent.enabled }, set: { agent.setEnabled($0) }))
      } header: {
        Text("This Mac")
      } footer: {
        Text("While Hatbot is open, its tasks can use this Mac's screen, files and commands, as you. They ask you first.")
      }
      if agent.enabled, let s = agent.state {
        if !s.control || !s.screen {
          Section {
            if !s.control {
              LabeledContent("Accessibility") {
                Button("Allow") { openSettings("Privacy_Accessibility") }.buttonStyle(.material(.tonal))
              }
            }
            if !s.screen {
              LabeledContent("Screen Recording") {
                Button("Allow") { openSettings("Privacy_ScreenCapture") }.buttonStyle(.material(.tonal))
              }
            }
          } header: {
            Text("macOS permissions")
          } footer: {
            Text("Hatbot needs both to use the screen. After allowing Screen Recording, quit Hatbot and open it again.")
          }
        }
        Section("Status") {
          LabeledContent("Connection", value: s.connection == "connected" ? "Connected to Hatbot" : "Not connected to Hatbot")
          LabeledContent(
            "This Mac", value: s.status.locked ? "Locked" : s.status.ownerActive ? "You're using it" : "Idle")
          if s.status.screen != nil {
            LabeledContent("Hatbot is using it") {
              Button("Stop", role: .destructive) { agent.stopTask() }.buttonStyle(.material(.tonal))
            }
          }
          Toggle("Paused", isOn: Binding(get: { s.status.paused }, set: { agent.setPaused($0) }))
        }
      }
    }

    private func openSettings(_ pane: String) {
      guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
      UIApplication.shared.open(url)
    }
  }

  /// Over the app while a task uses this Mac, as the desktop app's banner.
  struct MacAgentBanner: View {
    private let agent = MacAgent.shared

    var body: some View {
      if agent.state?.status.screen != nil {
        HStack {
          Text("Hatbot is using this Mac").font(.sans(.subheadline, .medium))
          Spacer()
          Button("Stop", role: .destructive) { agent.stopTask() }
            .buttonStyle(.material(.tonal))
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.attention.opacity(0.25))
      }
    }
  }
#endif
