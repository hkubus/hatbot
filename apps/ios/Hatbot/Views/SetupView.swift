import SwiftUI

/// Signed in before the guided setup is finished: a model provider and its key first, as the web app asks
/// for them, then the bot's interview, which is the web app's.
struct SetupView: View {
  let store: AppStore
  let setup: Session.Setup

  var body: some View {
    NavigationStack {
      switch setup {
      case .models: ModelsForm()
      case .interview: Interview(store: store)
      }
    }
  }
}

private struct ModelsForm: View {
  @Environment(Session.self) private var session
  @State private var provider = SetupProvider.anthropic
  @State private var key = ""
  @State private var baseUrl = ""
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    TiledForm {
      Section {
        Picker("Provider", selection: $provider) {
          ForEach(SetupProvider.allCases, id: \.self) { p in Text(p.name).tag(p) }
        }
        .pickerStyle(.segmented)
        SecureField("API key", text: $key, prompt: Text(provider == .anthropic ? "API key (sk-ant-…)" : "API key"))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.go)
          .onSubmit { save() }
        if provider == .openai {
          TextField("Address of the API", text: $baseUrl, prompt: Text("https://openrouter.ai/api/v1"))
            .textContentType(.URL)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
      } footer: {
        if let error { Text(error).foregroundStyle(Color.danger) }
      }
      Section {
        Button(action: save) {
          HStack {
            Text(busy ? "Checking…" : "Continue")
            if busy {
              Spacer()
              ProgressView()
            }
          }
        }
        .disabled(busy || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .navigationTitle("Choose your models")
  }

  private func save() {
    guard !busy, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    busy = true
    error = nil
    Task {
      do {
        try await session.setModels(provider, key: key, baseUrl: baseUrl)
      } catch {
        self.error = message(for: error)
      }
      busy = false
    }
  }
}

private struct Interview: View {
  let store: AppStore
  @Environment(Session.self) private var session
  @Environment(\.openURL) private var openURL
  @State private var opening = false
  @State private var error: String?

  var body: some View {
    ContentUnavailableView {
      Label("Finish setting up Hatbot in the web app", systemImage: "safari")
    } description: {
      if let error { Text(error).foregroundStyle(Color.danger) }
    } actions: {
      Button("Open the web app", action: open)
        .buttonStyle(.material(.filled))
        .disabled(opening)
      Button("Finish later") { session.finishLater() }
        .buttonStyle(.material(.outlined))
    }
    .navigationTitle("Hatbot")
  }

  /// At the interview, signed in as this app.
  private func open() {
    opening = true
    error = nil
    Task {
      do {
        openURL(try await store.api.webLink(to: "/welcome"))
      } catch {
        self.error = message(for: error)
      }
      opening = false
    }
  }
}
