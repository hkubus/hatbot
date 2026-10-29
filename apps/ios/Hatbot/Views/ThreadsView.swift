import SwiftUI

/// A bot's threads: open ones first, the latest first.
struct ThreadsView: View {
  let parentId: Int
  @Environment(AppStore.self) private var store

  private var list: [Conversation] {
    store.threads.values.filter { $0.parentId == parentId }.sorted { a, b in
      if (a.resolvedAt == nil) != (b.resolvedAt == nil) { return a.resolvedAt == nil }
      let (x, y) = (store.threadNeedsYou(a), store.threadNeedsYou(b))
      if x != y { return x }
      return (a.lastMessageAt ?? "") > (b.lastMessageAt ?? "")
    }
  }

  var body: some View {
    List(list) { t in
      Button {
        Task { await store.openThread(t.id) }
      } label: {
        ThreadLine(t: t, title: "")
      }
      .foregroundStyle(.primary)
      .listRowBackground(store.threadNeedsYou(t) ? Color.attention.opacity(0.18) : nil)
    }
    .overlay {
      if list.isEmpty {
        ContentUnavailableView(
          "No threads", systemImage: "bubble.left.and.text.bubble.right",
          description: Text("A bot opens one when something needs a conversation of its own."))
      }
    }
    .navigationTitle("Threads")
    .task { try? await store.loadThreads(parentId) }
  }
}

/// A thread's card in its chat.
struct ThreadCard: View {
  let id: Int
  let title: String
  @Environment(AppStore.self) private var store

  var body: some View {
    Button {
      Task { await store.openThread(id) }
    } label: {
      let needsYou = store.threads[id].map(store.threadNeedsYou) ?? false
      ThreadLine(t: store.threads[id], title: title)
        .padding(12)
        .background(
          needsYou ? AnyShapeStyle(Color.attention.opacity(0.18)) : AnyShapeStyle(.fill.tertiary),
          in: .rect(cornerRadius: 14))
    }
    .buttonStyle(.plain)
  }
}

struct ThreadLine: View {
  let t: Conversation?
  let title: String

  var body: some View {
    let unread = t?.unread ?? 0
    HStack(spacing: 12) {
      Image(systemName: unread > 0 ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.and.text.bubble.right")
        .foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: t?.title ?? title).fontWeight(.semibold).lineLimit(1)
        if let line { Text(verbatim: line).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
      }
      Spacer(minLength: 8)
      if unread > 0 { Count(n: unread) }
    }
  }

  private var line: String? {
    guard let t else { return nil }
    if t.resolvedAt != nil { return "Resolved: \(t.outcome ?? "by you")" }
    let latest = Markdown.plain(t.latest ?? "")
    return latest.isEmpty ? nil : latest
  }
}
