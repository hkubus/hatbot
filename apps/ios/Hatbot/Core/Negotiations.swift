// Haggling on a marketplace inside a mandate (apps/web/src/negotiations.tsx and pages/Negotiation.tsx).
import Foundation

extension AppStore {
  /// The open ones. One held as open that isn't listed ended while the app was away, and is read again.
  func loadNegotiations() async throws {
    let list: [Negotiation] = try await api.get("/negotiations?status=open")
    let listed = Set(list.map(\.id))
    let ended = negotiations.values.filter { $0.status.isOpen && !listed.contains($0.id) }.map(\.id)
    for n in list { keepNewer(n) }
    for id in ended { try? await loadNegotiation(id) }
  }

  func loadNegotiation(_ id: Int) async throws {
    do {
      let d: NegotiationDetail = try await api.get("/negotiations/\(id)")
      keepNewer(d.negotiation)
      negotiationMessages[id] = d.messages
    } catch let error as APIError where error.status == 404 {
      negotiations[id] = nil
      negotiationMessages[id] = nil
      throw error
    }
  }

  /// Nothing more goes to the other side, and its tasks stop.
  func stopNegotiation(_ id: Int) async throws {
    let d: NegotiationDetail = try await api.post("/negotiations/\(id)/close", body: Empty())
    negotiations[id] = d.negotiation
    negotiationMessages[id] = d.messages
  }

  var openNegotiations: [Negotiation] {
    negotiations.values.filter(\.status.isOpen).sorted { $0.id > $1.id }
  }

  /// The negotiation an approval is about: its mandate, or a hold. A mandate for several sellers has one
  /// approval for all of them: the first stands for it.
  func negotiation(forApproval id: Int) -> Negotiation? {
    negotiations.values.filter { $0.approvalId == id }.min { $0.id < $1.id }
  }

  /// As `negotiation(forApproval:)`, loading the open ones first when it isn't known. A task's approval
  /// belongs to its task.
  func findNegotiation(for a: Approval) async -> Negotiation? {
    guard a.taskId == nil else { return nil }
    if let n = negotiation(forApproval: a.id) { return n }
    try? await loadNegotiations()
    return negotiation(forApproval: a.id)
  }

  /// A list read before an event came mustn't undo it.
  private func keepNewer(_ n: Negotiation) {
    if let held = negotiations[n.id], held.updatedAt > n.updatedAt { return }
    negotiations[n.id] = n
  }
}

extension Negotiation {
  /// Who's on the other side.
  var them: String { role == .sell ? "buyer" : "seller" }

  /// Where it stands, in a line. Their words are quoted as written, never as Markdown.
  func line(now: Date = .now) -> String {
    let currency = mandate.currency
    switch status {
    case .awaitingMandate:
      return "Waiting for your approval."
    case .open:
      guard let last = lastMessage else {
        if let at = Format.date(nextFollowUpAt), at > now {
          return "Writes to the \(them) at \(at.formatted(date: .omitted, time: .shortened))."
        }
        return "Writing to the \(them)."
      }
      let said = Self.quote(last.text)
      switch (last.direction, last.status) {
      case (.incoming, _): return "The \(them) wrote \(said)"
      case (.owner, _): return "You wrote \(said)"
      case (_, .sending): return "Sending \(said)"
      case (_, .unconfirmed): return "Sent, but not confirmed: \(said)"
      case (_, .failed): return "Not sent: \(said)"
      default: return "Sent \(said)"
      }
    case .agreed:
      return agreedPrice.map { "Agreed at \(Format.price($0, currency))." } ?? "Agreed."
    case .lost:
      return role == .sell ? "The buyer said no." : "The seller sold it or said no."
    case .abandoned:
      return "Abandoned."
    case .expired:
      // Ended at or after its mandate's end: it ran out. Before: it was never approved.
      if let closed = Format.date(closedAt), let end = Format.date(mandate.expiresAt), end <= closed {
        return "The mandate ran out."
      }
      return "The mandate wasn't approved in time."
    case .paid:
      return agreedPrice.map { "Paid \(Format.price($0, currency))." } ?? "Paid."
    case .received:
      return "Received."
    }
  }

  private static func quote(_ text: String) -> String {
    "“\(text.count > 200 ? String(text.prefix(199)) + "…" : text)”"
  }
}

extension Format {
  /// "1,200 zł", "45.5 EUR": złoty as Poles write it, other currencies by their code.
  static func price(_ n: Double, _ currency: String, locale: Locale = .current) -> String {
    let amount = n.formatted(.number.precision(.fractionLength(0...2)).locale(locale))
    return "\(amount) \(currency == "PLN" ? "zł" : currency)"
  }
}
