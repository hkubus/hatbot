// Settings → Spend in detail (web Spend.tsx), the spending limits, and the signed-in devices.
import SwiftUI
import UIKit

struct SpendView: View {
  @Environment(AppStore.self) private var store
  @State private var detail: SpendDetail?
  @State private var error: String?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red) }
      if let detail {
        chart("Last 24 hours", SpendCharts.hourly(detail.hourly))
        chart("Last 30 days", SpendCharts.daily(detail.daily))
        chart("By model, last 30 days", SpendCharts.byModel(detail.byModel))
        if store.botIds.count > 1 {
          let names = store.bots.mapValues(\.name)
          chart("By bot, last 30 days", SpendCharts.byBot(detail.byBot, names: names))
        }
        chart("By purpose, last 30 days", SpendCharts.byPurpose(detail.byPurpose))
      }
    }
    .overlay { if detail == nil && error == nil { ProgressView() } }
    .navigationTitle("Spend")
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .refreshable { await load() }
  }

  @ViewBuilder
  private func chart(_ title: String, _ spec: ChartSpec?) -> some View {
    if let spec {
      Section(title) { ChartView(spec: spec).padding(.vertical, 6) }
    }
  }

  private func load() async {
    do {
      detail = try await store.loadSpendDetail()
      error = nil
    } catch {
      self.error = message(for: error)
    }
  }
}

/// What a task, a day and a month may cost; past one, Hatbot stops and asks.
struct LimitsView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var limits: Limits?
  @State private var saved: Limits?
  @State private var saving = false
  @State private var error: String?
  /// Fields that are blank or aren't a number: they keep the last number, which Save mustn't send.
  @State private var unreadable: Set<String> = []

  var body: some View {
    Form {
      if let error { Text(error).foregroundStyle(.red) }
      if limits != nil {
        Section {
          field("Each task", \.taskUsd)
          if limits?.researchUsd != nil {
            field("Each research task", optional: \.researchUsd)
          }
          field("Each day", \.dailyUsd)
          field("Each month", \.monthlyUsd)
          if limits?.alertReserveUsd != nil {
            field("Kept for alerts", optional: \.alertReserveUsd)
          }
        } footer: {
          Text("In dollars. Hatbot stops before going past one.")
        }
      }
    }
    .overlay { if limits == nil && error == nil { ProgressView() } }
    .navigationTitle("Limits")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") { Task { await save() } }
          .disabled(saving || limits == nil || limits == saved || !valid)
      }
      // The decimal pad has no Return to put it away.
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") {
          UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
      }
    }
    .task { await load() }
    // Changed elsewhere: shown, unless you're changing them here.
    .onChange(of: store.settingsVersion) {
      if limits == saved { Task { await load() } }
    }
  }

  private func load() async {
    do {
      let s = try await store.loadSettings()
      limits = s.limits
      saved = s.limits
    } catch {
      self.error = message(for: error)
    }
  }

  private var valid: Bool {
    guard let l = limits, unreadable.isEmpty else { return false }
    return l.taskUsd > 0 && (l.researchUsd ?? 1) > 0 && l.dailyUsd > 0 && l.monthlyUsd > 0
      && (l.alertReserveUsd ?? 0) >= 0
  }

  private func field(_ label: String, _ key: WritableKeyPath<Limits, Double>) -> some View {
    field(label, Binding(get: { limits?[keyPath: key] ?? 0 }, set: { limits?[keyPath: key] = $0 }))
  }

  private func field(_ label: String, optional key: WritableKeyPath<Limits, Double?>) -> some View {
    field(label, Binding(get: { limits?[keyPath: key] ?? 0 }, set: { limits?[keyPath: key] = $0 }))
  }

  private func field(_ label: String, _ value: Binding<Double>) -> some View {
    LabeledContent(label) { MoneyField(label: label, value: value, unreadable: $unreadable) }
  }

  private func save() async {
    guard let limits else { return }
    saving = true
    error = nil
    do {
      saved = try await store.setLimits(limits).limits
      dismiss()
    } catch {
      self.error = message(for: error)
    }
    saving = false
  }
}

/// Dollars, read as they're typed. A field bound to a number takes it only on Return or when it loses
/// focus, and the decimal pad has no Return, so Save didn't know a new limit had been typed.
private struct MoneyField: View {
  let label: String
  @Binding var value: Double
  @Binding var unreadable: Set<String>
  @State private var text = ""
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 2) {
      Text("$").foregroundStyle(.secondary)
      TextField(label, text: $text)
        .keyboardType(.decimalPad)
        .multilineTextAlignment(.trailing)
        .focused($focused)
    }
    .onAppear { text = Format.amountText(value) }
    .onChange(of: text) { _, typed in
      if let amount = Format.amount(typed) {
        // Shown to the cent: a limit like 0.125 stays itself until you type another.
        if typed != Format.amountText(value) { value = amount }
        unreadable.remove(label)
      } else {
        unreadable.insert(label)
      }
    }
    // Loaded or saved meanwhile: shown, unless you're typing.
    .onChange(of: value) { _, v in if !focused { text = Format.amountText(v) } }
    .onChange(of: focused) { _, now in if !now { text = Format.amountText(value) } }
  }
}

/// The apps and scripts signed in with a token; revoking one signs it out.
struct DevicesView: View {
  @Environment(AppStore.self) private var store
  @State private var tokens: [ApiToken]?
  @State private var revoking: ApiToken?
  @State private var error: String?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red) }
      if let tokens, tokens.isEmpty {
        Text("Nothing is signed in with a token.").foregroundStyle(.secondary)
      }
      ForEach(tokens ?? []) { t in
        VStack(alignment: .leading, spacing: 3) {
          Text(t.name)
          Text(line(t)).font(.footnote).foregroundStyle(.secondary)
        }
        .swipeActions {
          Button("Revoke", role: .destructive) { revoking = t }
        }
        .contextMenu {
          Button("Revoke", systemImage: "xmark.circle", role: .destructive) { revoking = t }
        }
      }
    }
    .overlay { if tokens == nil && error == nil { ProgressView() } }
    .navigationTitle("Signed-in devices")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog(
      "Revoke “\(revoking?.name ?? "")”?",
      isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      titleVisibility: .visible,
      presenting: revoking
    ) { t in
      Button("Revoke", role: .destructive) { Task { await revoke(t) } }
    } message: { _ in
      Text("It's signed out. If it's this iPhone, you'll need to sign in again.")
    }
    .task { await load() }
    .refreshable { await load() }
  }

  private func line(_ t: ApiToken) -> String {
    let added = "Added \(t.createdAt.stampText)"
    guard let used = t.lastUsedAt else { return "\(added), never used" }
    return "\(added), last used \(used.stampText)"
  }

  private func load() async {
    do {
      tokens = try await store.loadTokens()
      error = nil
    } catch {
      self.error = message(for: error)
    }
  }

  private func revoke(_ t: ApiToken) async {
    error = nil
    do {
      try await store.revokeToken(t.id)
      tokens?.removeAll { $0.id == t.id }
    } catch {
      self.error = message(for: error)
    }
  }
}
