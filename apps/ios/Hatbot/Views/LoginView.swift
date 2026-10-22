import SwiftUI
import UIKit

struct LoginView: View {
  @Environment(Session.self) private var session
  @State private var password = ""
  @State private var code = ""
  @State private var busy = false
  @State private var error: String?
  @FocusState private var field: Field?

  /// What the token is called in Signed-in devices: "iPhone (Hatbot iOS) 15 Oct 2026".
  static var deviceName: String {
    "\(UIDevice.current.model) (Hatbot iOS) \(Date().formatted(.dateTime.day().month(.abbreviated).year()))"
  }

  private enum Field { case server, password, code }

  var body: some View {
    @Bindable var session = session
    NavigationStack {
      Form {
        Section {
          TextField("Address", text: $session.server, prompt: Text("hatbot.example.com"))
            .textContentType(.URL)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($field, equals: .server)
            .submitLabel(.next)
            .onSubmit { field = .password }
          SecureField("Password", text: $password)
            .textContentType(.password)
            .focused($field, equals: .password)
            .submitLabel(.next)
            .onSubmit { field = .code }
          TextField("Code", text: $code)
            .textContentType(.oneTimeCode)
            .keyboardType(.numberPad)
            .focused($field, equals: .code)
            .onChange(of: code) { _, value in
              code = String(value.filter(\.isNumber).prefix(6))
              if code.count == 6 && !password.isEmpty { signIn() }
            }
        } footer: {
          if let error { Text(error).foregroundStyle(.red) }
        }
        Section {
          Button(action: signIn) {
            HStack {
              Text("Sign in")
              if busy {
                Spacer()
                ProgressView()
              }
            }
          }
          .disabled(busy || session.server.isEmpty || password.isEmpty || code.count != 6)
        }
      }
      .navigationTitle("Hatbot")
      .onAppear { field = session.server.isEmpty ? .server : .password }
    }
  }

  private func signIn() {
    guard !busy else { return }
    busy = true
    error = nil
    Task {
      do {
        try await session.signIn(password: password, code: code, device: Self.deviceName)
      } catch {
        self.error = message(for: error)
        code = ""
      }
      busy = false
    }
  }
}
