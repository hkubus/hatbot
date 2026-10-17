// The thread (PLAN.md §10.2, §10.4): Messages-style bubbles, grouped by sender with a tail on the
// last, a centered time after a pause, Copy and Open in a long-press menu. A task shows under the reply
// that started it; approvals wait above the composer. Finished conversations fold up under their recap.
import PhotosUI
import SwiftUI
import UIKit

struct ChatView: View {
  /// Kept in MainView, like the other sections', so it survives going to another section and back.
  @Binding var path: [Route]
  /// A message to scroll to, from Search: earlier pages load until it's there.
  @Binding var focus: Int?
  @Environment(AppStore.self) private var store
  @State private var error: String?
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var loaded = false
  @State private var unfolded = Set<Int>()
  /// The folded conversation you asked to delete, waiting for you to confirm.
  @State private var deleting: Int?
  @State private var rowCache = RowCache()
  @State private var router = OpenRoute()
  private var name: String { store.chatName(store.currentChat) }
  @State private var farFromBottom = false
  static let readingWidth: CGFloat = 720
  @State private var nearBottom = true
  /// The round button's glyph box, growing with Dynamic Type like its glyph.
  @ScaledMetric(relativeTo: .body) private var glyphWidth: CGFloat = 26
  @ScaledMetric(relativeTo: .body) private var glyphHeight: CGFloat = 30

  /// What the list shows: times, folds, and the messages that aren't folded away.
  fileprivate enum Row: Identifiable {
    case time(String, before: Int)
    case fold(ThreadGroup)
    /// `joined`: it follows a message from the same sender; `tail`: it's the last of them.
    case message(ThreadMessage, joined: Bool = false, tail: Bool = true)

    var id: String {
      switch self {
      case let .time(_, before): "t\(before)"
      case let .fold(g): "f\(g.id)"
      case let .message(m, _, _): "m\(m.id)"
      }
    }
  }

  /// The rows, worked out again only when what they're made of changes, not on every redraw.
  fileprivate final class RowCache {
    struct Key: Equatable {
      var messages: [ThreadMessage]
      var episodes: [Int: Episode]
      var unfolded: Set<Int>
      var unread: [Int]
    }

    var key: Key?
    var rows: [Row] = []
  }

  private var rows: [Row] {
    let key = RowCache.Key(messages: store.messages, episodes: store.episodes, unfolded: unfolded, unread: store.unread)
    if rowCache.key == key { return rowCache.rows }
    var rows: [Row] = []
    var previous: ThreadMessage?
    func add(_ m: ThreadMessage, as row: Row) {
      if let time = Self.pause(m, after: previous) { rows.append(.time(time, before: m.id)) }
      previous = m
      rows.append(row)
    }
    func add(_ m: ThreadMessage) { add(m, as: .message(m)) }
    let unread = Set(key.unread)
    for g in ThreadFolds.groups(key.messages, episodes: key.episodes) {
      guard g.fold != nil, let id = g.episodeId else {
        for m in g.messages { add(m) }
        continue
      }
      add(g.messages[0], as: .fold(g))
      // A message you haven't seen stays in view.
      let shown = unfolded.contains(id) ? g.messages : g.messages.filter { unread.contains($0.id) }
      for m in shown { add(m) }
    }
    rowCache.key = key
    rowCache.rows = Self.grouped(rows)
    return rowCache.rows
  }

  /// Runs of messages from the same sender sit close together, with a tail on the last. In a group
  /// each bot is a sender of its own.
  private static func grouped(_ rows: [Row]) -> [Row] {
    func sender(_ row: Row?) -> String? {
      if case let .message(m, _, _)? = row, !m.isNote { key(m) } else { nil }
    }
    func key(_ m: ThreadMessage) -> String { m.role == .user ? "owner" : "bot:\(m.botId ?? "")" }
    return rows.indices.map { i in
      guard case let .message(m, _, _) = rows[i] else { return rows[i] }
      let before = i > 0 ? rows[i - 1] : nil
      let after = i + 1 < rows.count ? rows[i + 1] : nil
      return .message(m, joined: sender(before) == key(m), tail: sender(after) != key(m))
    }
  }

  /// A group's bots, for the names above their messages and @ in the composer.
  private var members: [Bot]? {
    guard let c = store.currentChat, c.kind == .group else { return nil }
    return c.botIds.compactMap { store.bots[$0] }
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(spacing: 0) {
          // Scrolling up to the top loads the page before it; the bottom anchor keeps your place.
          if store.hasEarlier {
            ProgressView()
              .padding(.vertical, 8)
              .task(id: store.messages.first?.id) { try? await store.loadEarlier() }
          }
          if loaded && store.messages.isEmpty {
            Text(
              store.incognito
                ? "\(name) can't see earlier conversations here, and this one is deleted when you leave."
                : "Say hello to \(name)."
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.top, 40)
          }
          let group = members != nil
          ForEach(rows) { row in
            switch row {
            case let .time(time, _):
              Text(time).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                .padding(.top, 14)
                .padding(.bottom, 4)
            case let .fold(g):
              FoldRow(group: g, open: g.episodeId.map { unfolded.contains($0) } ?? false) {
                guard let id = g.episodeId else { return }
                withAnimation(.snappy) {
                  if unfolded.remove(id) == nil { unfolded.insert(id) }
                }
              }
              .contextMenu {
                Button("Delete Conversation", systemImage: "trash", role: .destructive) {
                  deleting = g.episodeId
                }
              }
              .padding(.top, 10)
            case let .message(m, joined, tail):
              // In a group, the bot's name above each run of its messages.
              let named = group && !joined && m.role == .assistant && !m.isNote
              if named {
                Text(store.botName(m.botId))
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(m.botId.flatMap { store.bots[$0]?.color.color } ?? .secondary)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(.leading, 14)
                  .padding(.top, 10)
              }
              MessageRow(m: m, tail: tail)
                .equatable()
                .padding(.top, joined || named ? 2 : 10)
            }
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        // So a search hit can be scrolled to by its row's id.
        .scrollTargetLayout()
        // A column you can read across on an iPad or a Mac.
        .frame(maxWidth: Self.readingWidth)
        .frame(maxWidth: .infinity)
      }
      .scrollPosition($position)
      .defaultScrollAnchor(.bottom)
      // A reply streaming in is followed only from the bottom; scrolled up, your place stays. An
      // earlier page going in above keeps it from the bottom.
      .defaultScrollAnchor(nearBottom || store.prepending ? .bottom : .top, for: .sizeChanges)
      .onScrollGeometryChange(for: CGFloat.self) { geo in
        geo.contentSize.height - geo.visibleRect.maxY
      } action: { _, distance in
        if nearBottom != (distance < 60) { nearBottom = distance < 60 }
        let far = distance > 400
        if far != farFromBottom { withAnimation(.snappy) { farFromBottom = far } }
      }
      .overlay(alignment: .bottom) {
        if farFromBottom {
          Button {
            withAnimation { position.scrollTo(edge: .bottom) }
          } label: {
            Image(systemName: "arrow.down")
              .font(.body.weight(.semibold))
              .frame(width: glyphWidth, height: glyphHeight)
          }
          .glassButton()
          .buttonBorderShape(.circle)
          .padding(.bottom, 8)
          .transition(.scale.combined(with: .opacity))
          .accessibilityLabel("Scroll to bottom")
        }
      }
      .scrollDismissesKeyboard(.interactively)
      .edgeBar(.top) {
        VStack(spacing: 0) {
          if store.unreachable { UnreachableBanner() }
          if store.paused { PausedBanner() }
        }
        .animation(.snappy, value: store.unreachable)
      }
      .edgeBar(.bottom) {
        Composer(name: name, members: members, error: $error) {
          withAnimation { position.scrollTo(edge: .bottom) }
        }
      }
      .navigationTitle(store.incognito ? "Incognito" : name)
      .sidebarButton()
      .toolbar {
        if let c = store.currentChat {
          ToolbarItem(placement: .topBarTrailing) {
            NavigationLink(value: c.kind == .group ? Route.group(c.id) : Route.bot(c.botIds.first ?? Bot.hatbot)) {
              Image(systemName: "slider.horizontal.3")
            }
            .accessibilityLabel("About \(name)")
          }
        }
        // Groups have no incognito.
        if members == nil {
          ToolbarItem(placement: .topBarTrailing) {
            // Leaving deletes the incognito conversation.
            Button {
              Task { await store.setIncognito(!store.incognito) }
            } label: {
              Image(systemName: "eyeglasses")
                .foregroundStyle(store.incognito ? Color.accentColor : Color.primary)
            }
            .accessibilityLabel(store.incognito ? "Leave incognito" : "Incognito")
          }
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog(
        "Delete this conversation for good? \(name) forgets it too.",
        isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
        titleVisibility: .visible
      ) {
        Button("Delete", role: .destructive) {
          guard let id = deleting else { return }
          Task {
            do {
              error = nil
              try await store.deleteEpisode(id)
            } catch {
              self.error = message(for: error)
            }
          }
        }
      }
      .routes()
      .environment(\.openRoute, router)
      .onAppear { router.open = { route in path.append(route) } }
      .onChange(of: store.conversationId) {
        path = []
        unfolded = []
      }
      .task(id: focus) {
        guard let id = focus else { return }
        defer { focus = nil }
        guard await store.reveal(id), let m = store.messages.first(where: { $0.id == id }) else {
          error = "That message isn't in this chat any more."
          return
        }
        if let e = m.episodeId { unfolded.insert(e) }
        // Once its row is in the list.
        try? await Task.sleep(for: .milliseconds(150))
        withAnimation { position.scrollTo(id: "m\(id)", anchor: .center) }
      }
      .task {
        // Coming back to a chat that's loaded and live: the events kept it current. Otherwise the latest
        // page is merged in.
        if store.messages.isEmpty || !store.connected {
          do {
            try await store.loadThread()
          } catch {
            self.error = message(for: error)
          }
        }
        loaded = true
      }
    }
  }

  /// "Today 14:05", like Messages, when a message comes an hour or more after the one before.
  private static func pause(_ m: ThreadMessage, after previous: ThreadMessage?) -> String? {
    guard let date = m.date else { return nil }
    if let prev = previous?.date, date.timeIntervalSince(prev) < 3600 { return nil }
    let time = date.formatted(date: .omitted, time: .shortened)
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Today \(time)" }
    if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
    if let weekAgo = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: .now)), date >= weekAgo {
      return "\(date.formatted(.dateTime.weekday(.wide))) \(time)"
    }
    let thisYear = calendar.isDate(date, equalTo: .now, toGranularity: .year)
    let day = thisYear
      ? date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
      : date.formatted(.dateTime.day().month(.abbreviated).year())
    return "\(day) at \(time)"
  }
}

/// Each chat's draft and files, kept while you're elsewhere in the app.
@MainActor
@Observable
final class Drafts {
  /// Saved only when you leave a chat, so typing doesn't go through here.
  @ObservationIgnored var texts: [String: String] = [:]
  var files: [String: [ComposerFile]] = [:]

  func update(_ key: String, _ id: UUID, _ change: (inout ComposerFile) -> Void) {
    guard let i = files[key]?.firstIndex(where: { $0.id == id }) else { return }
    change(&files[key]![i])
  }
}

/// Pushes a page on the chat's navigation stack, from a message's menu. A class, so the messages see the
/// same one on every redraw.
@MainActor
final class OpenRoute {
  var open: (Route) -> Void = { _ in }
}

extension EnvironmentValues {
  @Entry var openRoute: OpenRoute?
}

/// The approval waiting for you, then the files, the "@" and "/" suggestions and the field. Your draft
/// lives here, so typing redraws only the composer.
private struct Composer: View {
  let name: String
  let members: [Bot]?
  @Binding var error: String?
  let sent: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(Drafts.self) private var drafts
  /// The draft as you type; kept in `drafts` when you leave the chat or switch to another.
  @State private var draft = ""
  @State private var photos: [PhotosPickerItem] = []
  @State private var pickingPhotos = false
  @State private var pickingFiles = false
  @State private var sending = false
  /// The round buttons' glyph box, growing with Dynamic Type like their glyphs.
  @ScaledMetric(relativeTo: .body) private var glyphWidth: CGFloat = 26
  @ScaledMetric(relativeTo: .body) private var glyphHeight: CGFloat = 30

  /// Whose draft and files these are: each chat has its own, and its incognito conversation another.
  private var key: String { "\(store.conversationId)\(store.incognito ? "i" : "")" }

  private var files: [ComposerFile] {
    get { drafts.files[key] ?? [] }
    nonmutating set { drafts.files[key] = newValue }
  }

  private var uploading: Bool { files.contains { $0.attachment == nil && $0.error == nil } }

  private var canSend: Bool {
    let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let hasFiles = files.contains { $0.attachment != nil }
    return (hasText || hasFiles) && !sending && !uploading
  }

  /// Adds a file to the composer and uploads it straight away.
  private func attach(_ data: Data, name: String, mediaType: String, preview: UIImage? = nil) {
    let f = ComposerFile(name: name, preview: preview)
    let key = key
    files.append(f)
    Task {
      // The chat it was attached in, even if you've gone to another meanwhile.
      do {
        let a = try await store.upload(data, name: name, mediaType: mediaType)
        drafts.update(key, f.id) { $0.attachment = a }
      } catch {
        drafts.update(key, f.id) { $0.error = message(for: error) }
        self.error = message(for: error)
      }
    }
  }

  var body: some View {
    VStack(spacing: 6) {
      // The oldest approval waiting for you; the next shows once you've answered it.
      if let a = store.pendingApprovals.first {
        VStack(alignment: .leading, spacing: 10) {
          ApprovalBody(approval: a).id(a.id)
          if store.pendingApprovals.count > 1 {
            Text("\(store.pendingApprovals.count - 1) more waiting")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassSurface(in: .rect(cornerRadius: 22))
      }
      if let error {
        Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
      }
      if !files.isEmpty {
        ComposerFiles(files: files) { id in files.removeAll { $0.id == id } }
      }
      if !mentionable.isEmpty {
        mentionList
      } else if !commands.isEmpty {
        commandList
      }
      HStack(alignment: .bottom, spacing: 8) {
        Menu {
          Button("Photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
          Button("Files", systemImage: "folder") { pickingFiles = true }
        } label: {
          Image(systemName: "paperclip")
            .font(.body.weight(.semibold))
            .frame(width: glyphWidth, height: glyphHeight)
        }
        .glassButton()
        .buttonBorderShape(.circle)
        .accessibilityLabel("Attach")
        TextField(store.incognito ? "Message \(name) incognito…" : "Message \(name)…", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .padding(.horizontal, 16)
          .padding(.vertical, 11)
          .glassSurface(in: .rect(cornerRadius: 22), interactive: true)
        Button { send() } label: {
          Image(systemName: "arrow.up")
            .font(.body.weight(.semibold))
            .foregroundStyle(canSend ? Color.onBrand : .secondary)
            .frame(width: glyphWidth, height: glyphHeight)
        }
        .glassButton(prominent: true)
        .buttonBorderShape(.circle)
        .tint(.brand)
        .disabled(!canSend)
        // With a keyboard, Return makes a new line and Command-Return sends.
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel("Send")
      }
      .glassGroup(spacing: 8)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 10, matching: .images)
    // A tap as it goes.
    .sensoryFeedback(.impact(weight: .light), trigger: sending) { _, sending in sending }
    .onAppear { draft = drafts.texts[key] ?? "" }
    .onDisappear { drafts.texts[key] = draft }
    .onChange(of: key) { old, new in
      drafts.texts[old] = draft
      draft = drafts.texts[new] ?? ""
    }
    .onChange(of: photos) { _, picked in
      guard !picked.isEmpty else { return }
      photos = []
      Task {
        for (i, item) in picked.enumerated() {
          let index = files.count + i + 1
          guard let photo = await Self.load(item, index: index) else {
            error = "Couldn't read that photo."
            continue
          }
          attach(photo.data, name: photo.name, mediaType: "image/jpeg", preview: photo.preview)
        }
      }
    }
    .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      guard case let .success(urls) = result else { return }
      Task {
        for url in urls.prefix(10) {
          guard let f = await Task.detached(operation: { PickedFile.file(url) }).value else {
            error = "Couldn't read \(url.lastPathComponent)."
            continue
          }
          attach(f.data, name: f.name, mediaType: f.mediaType)
        }
      }
    }
  }

  /// A picked photo, scaled from its file off the main thread; as data if the library won't give a file.
  private static func load(_ item: PhotosPickerItem, index: Int) async -> PickedFile.Photo? {
    if let file = try? await item.loadTransferable(type: PickedPhoto.self) {
      let url = file.url
      return await Task.detached {
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return PickedFile.photo(at: url, index: index)
      }.value
    }
    guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
    return await Task.detached { PickedFile.photo(data, index: index) }.value
  }

  private var commands: [ChatCommand] { ChatCommand.matching(draft, incognito: store.incognito) }

  /// In a group, the bots "@…" at the end of the draft could mean.
  private var mentionable: [Bot] {
    guard let members, let partial = Mention.partial(draft) else { return [] }
    return Mention.matching(partial, in: members)
  }

  private var mentionList: some View {
    VStack(spacing: 0) {
      ForEach(mentionable) { b in
        Button {
          draft = Mention.complete(draft, with: b.name)
        } label: {
          HStack(alignment: .firstTextBaseline) {
            Text("@\(b.name)").fontWeight(.medium)
            Spacer(minLength: 12)
            Text(b.instructions.split(separator: "\n").first.map(String.init) ?? "")
              .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.vertical, 4)
    .glassSurface(in: .rect(cornerRadius: 22))
  }

  /// What "/…" could mean. One that needs more goes in the composer to finish; the rest run at once.
  private var commandList: some View {
    VStack(spacing: 0) {
      ForEach(commands) { c in
        Button {
          if c.needsMore { draft = "/\(c.name) " } else { send("/\(c.name)") }
        } label: {
          HStack(alignment: .firstTextBaseline) {
            let args = Text(c.args.isEmpty ? "" : " \(c.args)").foregroundStyle(.secondary)
            Text("\(Text("/\(c.name)").fontWeight(.medium))\(args)")
            Spacer(minLength: 12)
            Text(c.description).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.vertical, 4)
    .glassSurface(in: .rect(cornerRadius: 22))
  }

  /// Sends the composer, or `command` when you picked one from the list.
  private func send(_ command: String? = nil) {
    let typed = command ?? draft
    let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let attached = command == nil ? files : []
    let ids = attached.compactMap { $0.attachment?.id }
    guard command != nil ? !sending : canSend else { return }
    sending = true
    error = nil
    // Cleared before it's sent, and put back if sending fails.
    draft = ""
    drafts.texts[key] = nil
    if command == nil { files = [] }
    sent()
    Task {
      // The keyboard can commit an autocorrection into the field just after it's cleared.
      try? await Task.sleep(for: .milliseconds(80))
      if !draft.isEmpty && typed.hasSuffix(draft) { draft = "" }
    }
    Task {
      do {
        try await store.send(text, attachmentIds: ids)
      } catch {
        if draft.isEmpty { draft = typed }
        if files.isEmpty && !attached.isEmpty { files = attached }
        self.error = message(for: error)
      }
      sending = false
    }
  }
}

struct PausedBanner: View {
  @Environment(AppStore.self) private var store

  var body: some View {
    HStack {
      Label("All activity is paused.", systemImage: "pause.circle.fill")
      Spacer()
      Button("Resume") { Task { try? await store.setPaused(false) } }
        .buttonStyle(.borderless)
        .fontWeight(.semibold)
    }
    .font(.subheadline)
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .glassSurface(in: .capsule)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }
}

/// The event stream has been down for a few seconds.
struct UnreachableBanner: View {
  var body: some View {
    HStack {
      Label("Can't reach Hatbot.", systemImage: "wifi.slash")
      Spacer()
    }
    .font(.subheadline)
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .glassSurface(in: .capsule)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .transition(.move(edge: .top).combined(with: .opacity))
  }
}

/// A finished conversation, folded up under its recap; a tap opens it in place.
private struct FoldRow: View {
  let group: ThreadGroup
  let open: Bool
  let toggle: () -> Void

  var body: some View {
    Button(action: toggle) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .rotationEffect(.degrees(open ? 90 : 0))
        Text(group.fold ?? "")
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(group.messages[0].date?.formatted(date: .omitted, time: .shortened) ?? "").font(.caption2)
      }
      .font(.subheadline)
      .foregroundStyle(.secondary)
      .padding(.vertical, 6)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityHint(open ? "Folds the conversation" : "Shows the conversation")
  }
}

// MARK: Messages

/// Equatable on what it's given, so a redraw of the chat skips the messages that didn't change; what it
/// reads from the store still redraws it.
private struct MessageRow: View, Equatable {
  let m: ThreadMessage
  /// The last of a run from the same sender, so its bubble has a tail.
  let tail: Bool
  @Environment(\.openRoute) private var router
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  /// The chat is kept, hidden, while another section shows: nothing in it is seen then.
  @Environment(\.sectionShown) private var sectionShown
  @State private var onScreen = false

  var body: some View {
    if m.isNote {
      // What came of a command: a quiet line rather than a message.
      Text(m.text)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    } else if m.role == .user {
      let shape = Bubble(tail: tail, side: .trailing)
      VStack(alignment: .trailing, spacing: 4) {
        if let list = m.attachments, !list.isEmpty { MessageFiles(list: list, alignment: .trailing) }
        if !m.text.isEmpty {
          Text(m.text)
            .foregroundStyle(.white)
            .textSelection(.enabled)
            .padding(Bubble.insets(.trailing))
            .background(Color.userBubble, in: shape)
            .contentShape(.contextMenuPreview, shape)
            .contextMenu { copyButton(m.text) }
            .modifier(Spoken(label: "You", text: m.text))
        }
      }
      .padding(.leading, 56)
      .frame(maxWidth: .infinity, alignment: .trailing)
    } else {
      let shape = Bubble(tail: tail, side: .leading)
      let unread = store.unread.contains(m.id)
      VStack(alignment: .leading, spacing: 3) {
        VStack(alignment: .leading, spacing: 8) { content }
          .padding(Bubble.insets(.leading))
          .background(Color.botBubble, in: shape)
          .contentShape(.contextMenuPreview, shape)
          .contextMenu { menu }
          .modifier(Spoken(label: store.botName(m.botId) + (unread ? ", unread" : ""), text: spokenText))
        // Like Messages' "Edited": the task's result changed this message after it was sent.
        if m.status != .streaming, let editedAt {
          Text("Edited \(editedAt.timeText)")
            .font(.caption2)
            .foregroundStyle(Color.brandText)
            .padding(.leading, Bubble.tailWidth + 12)
        }
      }
      .padding(.trailing, 40)
      .frame(maxWidth: .infinity, alignment: .leading)
      // Unread: an accent line at the edge, fading once you've seen it.
      .overlay(alignment: .leading) {
        Capsule().fill(Color.brand).frame(width: 3).padding(.vertical, 4).offset(x: -9)
          .opacity(unread ? 1 : 0)
          .animation(.easeOut(duration: 1), value: unread)
      }
      // Half of it on screen; or, for one too long for that, filling most of the screen or its end in view.
      .onGeometryChange(for: Bool.self) { geo in
        guard let screen = geo.bounds(of: .scrollView) else { return false }
        let me = CGRect(origin: .zero, size: geo.size)
        let shown = me.intersection(screen)
        guard !shown.isNull, shown.height > 0 else { return false }
        return shown.height >= me.height * 0.5 || shown.height >= screen.height * 0.6
          || (me.maxY > screen.minY && me.maxY <= screen.maxY)
      } action: { onScreen = $0 }
      // On screen for a moment, with the app and the chat in front: seen.
      .task(id: unread && onScreen && scenePhase == .active && sectionShown) {
        guard unread && onScreen && scenePhase == .active && sectionShown else { return }
        try? await Task.sleep(for: .seconds(1.5))
        if !Task.isCancelled { store.markSeen([m.id]) }
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch m.kind {
    case .task where m.taskId != nil: TaskMessage(taskId: m.taskId!)
    case .schedule where m.scheduleId != nil: ScheduleMessage(scheduleId: m.scheduleId!)
    default: ReplyMessage(m: m)
    }
    if m.status != .streaming, let list = m.sources, !list.isEmpty { MessageSources(list: list) }
    if let list = m.attachments, !list.isEmpty { MessageFiles(list: list, alignment: .leading) }
  }

  /// A plain reply, read as one: Markdown left out, and not word by word as it streams. Others, with
  /// tasks, schedules or approvals to act on, keep their parts.
  private var spokenText: String? {
    guard m.kind == .text || m.kind == .command, m.taskId == nil else { return nil }
    return m.status == .streaming ? "Writing" : Markdown.plain(m.text)
  }

  /// When a task's result changed the message after it was sent. A brain from before doesn't say: then a
  /// reply's task once it ends, or a task card that showed it running (one added when it ended wasn't).
  private var editedAt: String? {
    if let editedAt = m.editedAt { return editedAt }
    guard let task = m.taskId.flatMap({ store.tasks[$0] }), let done = task.finishedAt else { return nil }
    switch m.kind {
    case .text, .command: return done
    case .task: return done > m.createdAt ? done : nil
    case .schedule: return nil
    }
  }

  /// What Copy copies, and what Open opens.
  @ViewBuilder
  private var menu: some View {
    switch m.kind {
    case .schedule:
      if let id = m.scheduleId, let s = store.schedules[id] {
        copyButton(s.prompt)
        Button("Open schedule", systemImage: "chevron.right") { open(.schedule(id)) }
      }
    default:
      let task = m.taskId.flatMap { store.tasks[$0] }
      let result = task.flatMap { $0.isActive ? nil : $0.summary }
      if m.kind == .task {
        if let task { copyButton(result ?? task.title) }
      } else {
        // A finished or failed task's result in the reply's place.
        copyButton(task.map { ReplyMessage.showsResult(m, $0) } == true ? result ?? "" : m.text)
      }
      if let taskId = m.taskId { openButton(taskId) }
      if m.status == .error && m.role == .assistant {
        Button("Try again", systemImage: "arrow.clockwise") { retry() }
      }
    }
  }

  private func retry() {
    Task {
      do {
        try await store.retry(m.id)
      } catch let e as APIError where e.status == 409 {
        store.toast = "Only the latest reply can be tried again."
      } catch {
        store.toast = message(for: error)
      }
    }
  }

  private func copyButton(_ text: String) -> some View {
    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
  }

  private func openButton(_ taskId: Int) -> some View {
    Button("Open task", systemImage: "chevron.right") { open(.task(taskId)) }
  }

  private func open(_ route: Route) { router?.open(route) }

  nonisolated static func == (a: Self, b: Self) -> Bool { a.m == b.m && a.tail == b.tail }
}

/// A reply, with the task it started (if any) working under it. Once the task finishes or fails, its bot
/// writes the reply again to say what came of it; if it doesn't, the task's result shows in the reply's
/// place. A cancelled task leaves the reply.
private struct ReplyMessage: View {
  let m: ThreadMessage
  @Environment(AppStore.self) private var store

  static func ended(_ task: AgentTask) -> Bool {
    !task.isActive && task.status != .cancelled
  }

  /// The task ended and its bot didn't write the reply again: told some other way, or it failed to.
  static func showsResult(_ m: ThreadMessage, _ task: AgentTask) -> Bool {
    ended(task) && m.status != .streaming && (m.status == .error || m.text.isEmpty)
  }

  var body: some View {
    let task = m.taskId.flatMap { store.tasks[$0] }
    let ended = task.map(Self.ended) ?? false
    if let task, Self.showsResult(m, task) {
      TaskResult(taskId: task.id)
      if !m.text.isEmpty {
        Divider()
        MarkdownText(text: m.text)
      }
    } else {
      if m.status == .streaming, let reply = store.reply(m.id) {
        StreamingReply(reply: reply, dots: m.taskId == nil || ended)
      } else {
        if !m.text.isEmpty { MarkdownText(text: m.text) }
        if m.status == .streaming && m.text.isEmpty && (m.taskId == nil || ended) { TypingDots() }
      }
      if !ended, let taskId = m.taskId {
        if !m.text.isEmpty, let task, !task.isActive { Divider() }
        TaskResult(taskId: taskId)
      }
    }
  }
}

/// A reply as it's written. Each delta changes only `reply`, so only this redraws.
private struct StreamingReply: View {
  let reply: LiveReply
  /// Working dots until the first words, unless its task's dots show instead.
  let dots: Bool

  var body: some View {
    if !reply.text.isEmpty { MarkdownText(text: reply.text, streaming: true) }
    if reply.text.isEmpty && dots { TypingDots() }
    if let note = Format.lastLine(reply.progress) {
      Text(note).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
    }
    if let used = reply.usage {
      Text("\(Format.tokens(used.tokens)) tokens · \(String(format: "$%.3f", used.costUsd))")
        .font(.footnote.monospacedDigit())
        .foregroundStyle(.secondary)
    }
  }
}

/// A task under the reply that started it: working dots, then how it ended.
private struct TaskResult: View {
  let taskId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let task = store.tasks[taskId] {
        if task.isActive {
          let note = runningNote(task)
          TypingDots()
          if note != "Working…" {
            Text(note).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
          }
        } else if task.status == .done {
          MarkdownText(text: task.summary ?? "Done.")
        } else if task.status == .failed {
          MarkdownText(text: "**Didn't finish.** \(task.summary ?? "")")
        } else {
          Text("Cancelled.").foregroundStyle(.secondary)
        }
      }
    }
    .onAppear { store.ensureTask(taskId) }
  }

  private func runningNote(_ task: AgentTask) -> String {
    store.desktop?.control == .owner && task.status == .running
      ? "Paused while you have control."
      : Format.taskLine(task, progress: store.taskProgress[taskId])
  }
}

/// A background task (schedule, trigger), as a message: what it's doing, then how it ended.
private struct TaskMessage: View {
  let taskId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let task = store.tasks[taskId] {
        MarkdownText(text: text(task))
        if let result = result(task) { MarkdownText(text: result) }
        if task.isActive {
          Text(note(task)).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
        }
      }
    }
    .onAppear { store.ensureTask(taskId) }
  }

  private func text(_ task: AgentTask) -> String {
    if task.isActive { return "**\(task.title)**" }
    switch task.status {
    case .done: return "**\(task.title)**"
    case .failed: return "**\(task.title)** didn't finish."
    default: return "**\(task.title)** was cancelled."
    }
  }

  /// How it ended, under its title.
  private func result(_ task: AgentTask) -> String? {
    if task.isActive { return nil }
    switch task.status {
    case .done: return task.summary ?? "Done."
    case .failed: return task.summary
    default: return nil
    }
  }

  private func note(_ task: AgentTask) -> String {
    store.desktop?.control == .owner && task.status == .running
      ? "Paused while you have control."
      : Format.taskLine(task, progress: store.taskProgress[taskId])
  }
}

/// For VoiceOver, a bubble is one element: who it's from, then what it says. With no `text`, its parts
/// stay their own, under who it's from.
private struct Spoken: ViewModifier {
  let label: String
  let text: String?

  @ViewBuilder
  func body(content: Content) -> some View {
    if let text {
      content.accessibilityElement(children: .combine).accessibilityLabel(label).accessibilityValue(text)
    } else {
      content.accessibilityElement(children: .contain).accessibilityLabel(label)
    }
  }
}

/// What Hatbot wants to do and why, the page it read, a screenshot, then Deny and Approve.
struct ApprovalBody: View {
  let approval: Approval
  /// Off on the task's own page.
  var linksTask = true
  @Environment(AppStore.self) private var store
  /// In the chat: the task opens on its stack.
  @Environment(\.openRoute) private var router
  @State private var busy = false
  @State private var error: String?
  @State private var note = ""
  @State private var decided: Decision?

  var body: some View {
    let a = approval
    // The summary can be a whole shell command: shown as written, not read as Markdown.
    Text("\(Text("Can I go ahead?").bold()) \(a.summary)").textSelection(.enabled)
    let text = [
      a.reason,
      a.sources.isEmpty ? "" : "_After reading \(a.sources.joined(separator: ", "))_",
    ].filter { !$0.isEmpty }.joined(separator: "\n\n")
    if !text.isEmpty { MarkdownText(text: text) }
    if let taskId = a.taskId, let stepId = a.screenshotStepId {
      Screenshot(taskId: taskId, stepId: stepId)
    }
    if a.takesNote {
      TextField("Tell it what to do instead, or how to go ahead", text: $note, axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.roundedBorder)
    }
    if linksTask, let taskId = a.taskId, let router {
      Button("Open task") { router.open(.task(taskId)) }
        .font(.subheadline)
        .buttonStyle(.borderless)
    }
    if let error {
      Text(error).font(.footnote).foregroundStyle(.red)
    }
    // Full-size and well apart, so neither is pressed for the other.
    HStack(spacing: 16) {
      Button(role: .destructive) { decide(.deny) } label: { Text("Deny").frame(maxWidth: .infinity) }
        .glassButton()
      Button { decide(.approve) } label: { Text("Approve").frame(maxWidth: .infinity) }
        .glassButton(prominent: true)
        .tint(.attention)
    }
    .controlSize(.large)
    .disabled(busy)
    .sensoryFeedback(trigger: decided) { _, decided in
      switch decided {
      case .approve: .success
      case .deny: .warning
      case nil: nil
      }
    }
  }

  private func decide(_ decision: Decision) {
    busy = true
    error = nil
    Task {
      do {
        try await store.decide(approval.id, decision, note: note)
        decided = decision
      } catch {
        self.error = message(for: error)
        busy = false
      }
    }
  }
}

/// A schedule Hatbot made, as one line.
private struct ScheduleMessage: View {
  let scheduleId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let s = store.schedules[scheduleId] {
        let when = Format.when(cron: s.cron, runAt: s.runAt)
        MarkdownText(text: "Scheduled **\(s.name)**: \(when.prefix(1).lowercased() + when.dropFirst()).")
      } else if store.deletedSchedules.contains(scheduleId) {
        Text("Made a schedule that's since been deleted.")
      }
    }
    .onAppear { store.ensureSchedule(scheduleId) }
  }
}

/// A Messages bubble: a rounded rectangle, with a tail curling out of the bottom corner on `side`.
/// The tail's room is kept even without one, so a run of bubbles lines up.
private struct Bubble: Shape {
  var tail: Bool
  var side: HorizontalEdge
  static let tailWidth: CGFloat = 6

  /// The text's padding inside the bubble, with room for the tail.
  static func insets(_ side: HorizontalEdge) -> EdgeInsets {
    EdgeInsets(
      top: 7, leading: 12 + (side == .leading ? tailWidth : 0),
      bottom: 7, trailing: 12 + (side == .trailing ? tailWidth : 0))
  }

  func path(in rect: CGRect) -> Path {
    // Drawn with the tail on the right, then flipped for the left.
    let w = rect.width
    let h = rect.height
    let body = w - Self.tailWidth
    let r = min(18, h / 2, body / 2)
    var p = Path()
    p.move(to: CGPoint(x: r, y: 0))
    p.addArc(tangent1End: CGPoint(x: body, y: 0), tangent2End: CGPoint(x: body, y: h), radius: r)
    if tail && h >= r + 10 {
      p.addLine(to: CGPoint(x: body, y: h - 10))
      p.addCurve(to: CGPoint(x: w, y: h), control1: CGPoint(x: body, y: h - 3), control2: CGPoint(x: w - 2, y: h))
      p.addCurve(
        to: CGPoint(x: body - 9, y: h - 1.5),
        control1: CGPoint(x: w - 4, y: h - 0.5), control2: CGPoint(x: body - 3, y: h - 1.5))
      p.addQuadCurve(to: CGPoint(x: body - 13, y: h), control: CGPoint(x: body - 11, y: h))
    } else {
      p.addArc(tangent1End: CGPoint(x: body, y: h), tangent2End: CGPoint(x: 0, y: h), radius: r)
    }
    p.addArc(tangent1End: CGPoint(x: 0, y: h), tangent2End: CGPoint(x: 0, y: 0), radius: r)
    p.addArc(tangent1End: CGPoint(x: 0, y: 0), tangent2End: CGPoint(x: body, y: 0), radius: r)
    p.closeSubpath()
    let flip = side == .leading ? CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -w, y: 0) : .identity
    return p.applying(flip.concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
  }
}

/// The pages a reply cites, in a line of links.
private struct MessageSources: View {
  let list: [Source]

  var body: some View {
    Text(line)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .tint(.secondary)
  }

  private var line: AttributedString {
    var out = AttributedString("Sources: ")
    for (i, s) in list.enumerated() {
      if i > 0 { out += AttributedString(" · ") }
      var title = AttributedString(s.title.count > 60 ? "\(s.title.prefix(59))…" : s.title)
      title.link = URL(string: s.url)
      title.underlineStyle = .single
      out += title
    }
    return out
  }
}
