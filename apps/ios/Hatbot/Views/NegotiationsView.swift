// A negotiation's page, as the web's: what waits on you, the mandate, and the messages either way.
import SwiftUI

struct NegotiationView: View {
  let id: Int
  @Environment(AppStore.self) private var store
  @State private var missing = false
  @State private var error: String?
  @State private var confirmStop = false
  @State private var busy = false

  var body: some View {
    Group {
      if let n = store.negotiations[id], let messages = store.negotiationMessages[id] {
        content(n, messages)
      } else if missing {
        ContentUnavailableView("This negotiation doesn't exist.", systemImage: "questionmark.circle")
      } else if let error {
        ContentUnavailableView {
          Label(error, systemImage: "exclamationmark.triangle")
        } description: {
          EmptyView()
        } actions: {
          Button("Retry") { Task { await load() } }
        }
      } else {
        ProgressView()
      }
    }
    .navigationTitle(store.negotiations[id]?.title ?? "Negotiation")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: id) { await load() }
    .task(id: store.negotiations[id]?.approvalId) {
      if let a = store.negotiations[id]?.approvalId { store.ensureApproval(a) }
    }
  }

  private func load() async {
    await attempt($error, missing: $missing) { try await store.loadNegotiation(id) }
  }

  private func content(_ n: Negotiation, _ messages: [NegotiationMessage]) -> some View {
    TiledList {
      if let error {
        Text(error).foregroundStyle(Color.danger)
      }
      if let a = n.approvalId.flatMap({ store.approvals[$0] }) {
        Section { NegotiationApproval(approval: a) }
      }
      Section {
        VStack(alignment: .leading, spacing: 6) {
          if let url = URL(string: n.listingUrl), AppLink.opens(url) {
            Link(destination: url) {
              Text(verbatim: n.title).font(.sans(.title3, .bold)).multilineTextAlignment(.leading)
            }
          } else {
            Text(verbatim: n.title).font(.sans(.title3, .bold))
          }
          Text(n.status.label).font(.sans(.subheadline)).foregroundStyle(n.status.tint)
        }
        .padding(.vertical, 2)
        Text(verbatim: n.line()).foregroundStyle(.secondary)
      }
      Section { MandateRows(negotiation: n) }
      Section("Messages") {
        if messages.isEmpty {
          Text("None yet.").foregroundStyle(.secondary)
        }
        ForEach(messages) { m in
          if m.status.unsent, let taskId = m.taskId {
            NavigationLink(value: Route.task(taskId)) { MessageLine(message: m, negotiation: n) }
          } else {
            MessageLine(message: m, negotiation: n)
          }
        }
      }
    }
    .refreshable { await load() }
    .toolbar {
      if let url = n.conversationUrl.flatMap(URL.init(string:)), AppLink.opens(url) {
        ToolbarItem {
          Link(destination: url) { Label("Conversation", systemImage: "bubble.left.and.bubble.right") }
        }
      }
      if n.status.isOpen {
        ToolbarItem {
          Button("Stop", role: .destructive) { confirmStop = true }.disabled(busy)
        }
      }
    }
    .confirmationDialog(
      "Stop this negotiation? Nothing more goes to the \(n.them).", isPresented: $confirmStop,
      titleVisibility: .visible
    ) {
      Button("Stop", role: .destructive) {
        busy = true
        Task {
          await attempt($error) { try await store.stopNegotiation(id) }
          busy = false
        }
      }
    }
  }
}

/// Its mandate or hold, through the app's own approval: waiting on you, or what you decided.
private struct NegotiationApproval: View {
  let approval: Approval

  var body: some View {
    let a = approval
    switch a.status {
    case .pending:
      VStack(alignment: .leading, spacing: 10) { ApprovalBody(approval: a, linksTask: false) }
        .padding(.vertical, 4)
    case .blocked:
      BlockedBody(approval: a).padding(.vertical, 4)
    case .sending:
      SendingBody(approval: a)
    case .approved, .denied, .expired, .cancelled:
      // Plain text, never Markdown, as every approval is.
      VStack(alignment: .leading, spacing: 4) {
        Text(Self.decided[a.status] ?? "").font(.sans(.subheadline)).foregroundStyle(Self.tint(a.status))
        Text(verbatim: a.summary + (a.note.map { " You said: \($0)" } ?? "")).foregroundStyle(.secondary)
      }
      .padding(.vertical, 2)
    }
  }

  private static let decided: [Approval.Status: String] = [
    .approved: "Approved", .denied: "Denied", .expired: "Expired", .cancelled: "Cancelled",
  ]

  private static func tint(_ s: Approval.Status) -> Color {
    switch s {
    case .approved: .success
    case .denied: .danger
    default: .secondary
    }
  }
}

private struct MandateRows: View {
  let negotiation: Negotiation
  @Environment(AppStore.self) private var store

  var body: some View {
    let n = negotiation
    let m = n.mandate
    let price = { (x: Double) in Format.price(x, m.currency) }
    LabeledContent("Want") { Text(verbatim: n.want).multilineTextAlignment(.trailing) }
    LabeledContent("Bot", value: store.botName(n.botId))
    LabeledContent("Asking", value: n.asking.map(price) ?? "Unknown")
    LabeledContent("Opening offer", value: price(m.opening))
    LabeledContent("Target", value: price(m.target))
    LabeledContent(n.role == .sell ? "Take at least" : "Pay at most", value: price(m.limit))
    LabeledContent("Delivery") { Text(verbatim: m.delivery).multilineTextAlignment(.trailing) }
    LabeledContent("Until", value: m.expiresAt.stampText)
    LabeledContent("Contact details", value: m.allow.isEmpty ? "None" : m.allow.joined(separator: ", "))
    if let a = n.appraisal {
      VStack(alignment: .leading, spacing: 4) {
        Text("Scout")
        Text(
          verbatim:
            "Aim for \(Format.price(a.target, a.currency)), walk away \(n.role == .sell ? "below" : "above") "
            + "\(Format.price(a.walkAway, a.currency)). \(a.basis)"
        )
        .foregroundStyle(.secondary)
      }
    }
    let claims = saidSoFar(n)
    if !claims.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text("Said so far")
        Text(verbatim: claims).foregroundStyle(.secondary)
      }
    }
  }

  /// What the bot has told them about our side.
  private func saidSoFar(_ n: Negotiation) -> String {
    let c = n.claims
    let parts: [String?] = [
      c.max.map { "\(n.role == .sell ? "Takes at least" : "Pays at most") \(Format.price($0, n.mandate.currency))" },
      c.otherOffers.map { "Other offers: \($0)" },
      c.timing.map { "Timing: \($0)" },
    ]
    return (parts.compactMap { $0 } + c.other).joined(separator: ". ")
  }
}

private struct MessageLine: View {
  let message: NegotiationMessage
  let negotiation: Negotiation
  @Environment(AppStore.self) private var store

  var body: some View {
    let m = message
    VStack(alignment: .leading, spacing: 4) {
      // Their words as they wrote them, never Markdown.
      Text("\(Text(verbatim: who).bold()) \(Text(verbatim: m.text))").textSelection(.enabled)
      if let note = m.status.note {
        Text(note).font(.sans(.footnote)).foregroundStyle(m.status == .failed ? Color.danger : .secondary)
      }
      Text((m.sentAt ?? m.createdAt).stampText).font(.sans(.caption2)).foregroundStyle(.secondary)
    }
    .font(.sans(.subheadline))
    .padding(.vertical, 2)
  }

  private var who: String {
    switch message.direction {
    case .incoming: negotiation.role == .sell ? "Buyer" : "Seller"
    case .owner: "You"
    case .out: store.botName(negotiation.botId)
    }
  }
}

/// In the Tasks list.
struct NegotiationRow: View {
  let negotiation: Negotiation

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(verbatim: negotiation.title).lineLimit(2)
      Text(negotiation.status.label).font(.sans(.footnote)).foregroundStyle(negotiation.status.tint)
    }
  }
}

/// Under the reply that started it.
struct NegotiationResult: View {
  let id: Int
  @Environment(AppStore.self) private var store
  @Environment(\.openRoute) private var router

  var body: some View {
    HStack(spacing: 10) {
      if let n = store.negotiations[id] {
        Text("\(Text(verbatim: n.title).bold()): \(Text(verbatim: n.line()))").lineLimit(3)
        Spacer(minLength: 8)
        Button("Open") { router?.open(.negotiation(id)) }
          .buttonStyle(.material(.outlined))
          .controlSize(.small)
      }
    }
    .onAppear { store.ensureNegotiation(id) }
  }
}

extension NegotiationStatus {
  var label: String {
    switch self {
    case .awaitingMandate: "Needs approval"
    case .open: "Open"
    case .agreed: "Agreed"
    case .lost: "Lost"
    case .abandoned: "Abandoned"
    case .expired: "Expired"
    case .paid: "Paid"
    case .received: "Received"
    }
  }

  var tint: Color {
    switch self {
    case .awaitingMandate: .attention
    case .open: .accentColor
    case .agreed, .paid, .received: .success
    case .lost, .abandoned, .expired: .secondary
    }
  }
}

extension NegotiationMessage.Status {
  /// One of ours that didn't simply go: its task says why.
  var unsent: Bool { note != nil }

  var note: String? {
    switch self {
    case .sending: "Sending…"
    case .unconfirmed: "Send was clicked, but the message box didn't clear."
    case .failed: "Not sent."
    case .sent, .received: nil
    }
  }
}
