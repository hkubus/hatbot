// Same shape as apps/web/src/store.ts.
import Foundation
import Observation

@MainActor
@Observable
final class LiveReply {
  var text: String
  var progress = ""
  var usage: ReplyUsage?

  init(text: String) { self.text = text }
}

@MainActor
@Observable
final class AppStore {
  static let page = 50

  /// Not kept across launches: the brain deletes the incognito conversation after 30 idle minutes anyway.
  private(set) var incognito = false
  var messages: [ThreadMessage] = []
  var episodes: [Int: Episode] = [:]
  /// The replies being written, each in its own object: a delta then redraws only its bubble, not the chat.
  /// Watched, so a bubble takes up a new one even when its message doesn't change, as on a second rewrite.
  private var replies: [Int: LiveReply] = [:]
  /// Each load of the latest page in flight, with the message events that came meanwhile: the page may
  /// have been read before them, so they go on it again, as on the web.
  @ObservationIgnored private var missed: [UUID: [HatbotEvent]] = [:]
  var hasEarlier = false
  /// The open chat's messages are known, loaded or kept from last time: until then, none isn't an empty chat.
  private(set) var threadKnown = false
  private(set) var threadError: Error?
  @ObservationIgnored private var loadingEarlier = false
  private(set) var prepending = false
  @ObservationIgnored private var settling: Task<Void, Never>?
  var unread: [Int] = []
  var paused = false
  var todayUsd: Double?
  var monthUsd: Double?
  var connected = false
  /// The event stream has been down a few seconds while the app is in front.
  var unreachable = false
  @ObservationIgnored private var unreachableCheck: Task<Void, Never>?
  var tasks: [Int: AgentTask] = [:]
  var steps: [Int: [TaskStep]] = [:]
  var taskFiles: [Int: [Attachment]] = [:]
  var taskProgress: [Int: String] = [:]
  var approvals: [Int: Approval] = [:]
  var questions: [Int: Question] = [:]
  var desktop: DesktopState?
  var computers: [ComputerInfo] = []
  var schedules: [Int: Schedule] = [:]
  /// Schedules a message points at that no longer exist.
  var deletedSchedules: Set<Int> = []
  var triggers: [Int: Trigger] = [:]
  var deletedTriggers: Set<Int> = []
  /// Bumped when memory changes, so open memory views reload.
  var memoryVersion = 0
  /// Memory's files as loaded, or as kept from last time until they are; Memory and Spotlight share them.
  var memoryFiles: [MemoryFile]?
  @ObservationIgnored private(set) var memoryFilesLoaded = false
  var todos: TodoList?
  var proposals: [Int: Proposal] = [:]
  /// Bumped by settings.updated and heartbeat.updated, so open views refetch.
  var settingsVersion = 0
  var heartbeatVersion = 0
  var watchers: [Int: Watcher] = [:]
  var watchersLoaded = false
  /// Deleted while the app was open, so an open watcher says it's gone.
  var deletedWatchers = Set<Int>()
  /// Boxes: all of them once Boxes has been opened (`boxesLoaded`), and any a chat has shown.
  var boxes: [Int: Box] = [:]
  var boxesLoaded = false
  /// Deleted, here or elsewhere: an open box says so, and the chat stops showing it.
  var deletedBoxes = Set<Int>()
  var toast: String? {
    didSet { if toast != nil { toastId += 1 } }
  }
  /// Each note's own, so the same one again is shown for its full time again.
  private(set) var toastId = 0
  /// The chat that's showing: a bot's own, a group or a thread. Hatbot's own is the first.
  private(set) var conversationId = 1
  /// Your bots, deleted ones too once seen: old messages still name them.
  var bots: [String: Bot] = [:]
  var botIds: [String] = []
  /// Empty on brains from before bots.
  var conversations: [Conversation] = []
  /// The threads of the chats you've opened, by id; they stay out of the chat list.
  var threads: [Int: Conversation] = [:]
  @ObservationIgnored private var refreshing = false
  /// News came while the chats were loading: load them once more after.
  @ObservationIgnored private var refreshAgain = false
  @ObservationIgnored var refreshDelay: Duration = .milliseconds(300)
  /// What the chat list said of each chat when its page was last fetched ahead or found current on disk.
  @ObservationIgnored private var prefetched: [Int: (last: String?, unread: Int)] = [:]
  /// Chats opened since their page was fetched ahead: what they showed is newer, and stays.
  @ObservationIgnored private var visited = Set<Int>()
  @ObservationIgnored private var prefetching = false
  @ObservationIgnored private var prefetchAgain = false
  @ObservationIgnored private var seenQueue: [Int] = []
  @ObservationIgnored private var seenFlush: Task<Void, Never>?
  @ObservationIgnored private var wantedTasks: [Int] = []
  /// Tasks shown from disk, loaded again once the stream opens.
  @ObservationIgnored private var staleTasks = Set<Int>()
  /// The stream opened and its first event hasn't come: a snapshot, or from an older brain, not.
  @ObservationIgnored private var awaitingSnapshot = false

  @ObservationIgnored let api: API
  @ObservationIgnored private var requested = Set<String>()
  @ObservationIgnored private var stream: Socket?
  /// Messages in an incognito conversation: they're never unread.
  @ObservationIgnored private var incognitoIds = Set<Int>()

  @ObservationIgnored let cache: DiskCache?
  /// Signed out: a load still on its way mustn't write the cache back.
  @ObservationIgnored private var closed = false

  init(api: API, cache: DiskCache? = nil) {
    self.api = api
    self.cache = cache
    restore()
  }

  private func restore() {
    guard let cache, let chats = cache.chats() else { return }
    for b in chats.bots { bots[b.id] = b }
    botIds = chats.bots.map(\.id)
    conversations = chats.conversations
    if chats.conversations.contains(where: { $0.id == chats.conversationId }) { conversationId = chats.conversationId }
    if let page = cache.page(conversationId) {
      messages = page.messages
      hasEarlier = page.hasEarlier
      threadKnown = true
      for e in page.episodes { episodes[e.id] = e }
      restore(page.tasks)
    }
  }

  /// Tasks kept on disk, shown until they load again; ones already here are newer.
  private func restore(_ list: [AgentTask]) {
    for t in list where tasks[t.id] == nil {
      tasks[t.id] = t
      staleTasks.insert(t.id)
    }
  }

  func persist() {
    guard !closed, let cache else { return }
    if !conversations.isEmpty {
      cache.save(
        DiskCache.Chats(
          bots: botIds.compactMap { bots[$0] }, conversations: conversations, conversationId: listedChatId))
    }
    guard !incognito, !messages.isEmpty else { return }
    // Finished messages only: one still streaming would come back half written.
    let page = Array(messages.filter { $0.status != .streaming }.suffix(Self.page))
    let ids = Set(page.compactMap(\.episodeId))
    let taskIds = Set(page.compactMap(\.taskId))
    cache.save(
      DiskCache.Page(
        messages: page, episodes: ids.compactMap { episodes[$0] },
        hasEarlier: hasEarlier || page.count < messages.count, tasks: taskIds.compactMap { tasks[$0]?.card }),
      for: conversationId)
  }

  var needsYou: Int {
    approvals.values.filter { $0.status == .pending }.count + pendingQuestions.count
      + (desktop?.request == nil ? 0 : 1) + computers.filter { $0.request != nil }.count
  }

  var pendingQuestions: [Question] {
    questions.values.filter { $0.status == .pending }.sorted { $0.id < $1.id }
  }

  var pendingApprovals: [Approval] {
    approvals.values.filter { $0.status == .pending }.sorted { $0.id < $1.id }
  }

  // MARK: Event stream

  func connect() {
    if stream == nil { stream = makeStream() }
    if stream?.running == true { stream?.retryNow() } else { stream?.start() }
    noticeIfDown()
  }

  func disconnect() {
    persist()
    stream?.stop()
    connected = false
    unreachableCheck?.cancel()
    unreachable = false
  }

  /// Signed out: the stream stops and nothing more is kept, though tasks may still hold this store.
  func close() {
    closed = true
    disconnect()
  }

  /// "Can't reach Hatbot." only after a few seconds: a reconnect is usually quicker.
  private func noticeIfDown() {
    unreachableCheck?.cancel()
    unreachableCheck = Task { [weak self] in
      try? await Task.sleep(for: .seconds(4))
      guard let self, !Task.isCancelled, !self.connected, self.stream?.running == true else { return }
      self.unreachable = true
    }
  }

  private func makeStream() -> Socket {
    let api = self.api
    let socket = Socket { api.webSocket("/stream") }
    socket.onOpen = { [weak self] reconnected in self?.streamOpened(reconnected: reconnected) }
    socket.onMessage = { [weak self] message in
      guard case let .text(text) = message else { return }
      self?.streamed(try? JSONDecoder().decode(HatbotEvent.self, from: Data(text.utf8)))
    }
    socket.onClose = { [weak self] in
      self?.connected = false
      self?.noticeIfDown()
    }
    socket.onUnauthorized = { api.unauthorized() }
    return socket
  }

  func streamOpened(reconnected: Bool) {
    connected = true
    unreachableCheck?.cancel()
    unreachable = false
    // What's live comes as the stream's first event, which is on its way.
    awaitingSnapshot = true
    Task {
      // The first open too: what came between the chat's first load and the stream's start, or all of
      // it when that load failed.
      try? await loadThread()
      if reconnected && boxesLoaded { _ = try? await loadBoxes() }
    }
  }

  /// An event from the stream; nil, one this app couldn't read.
  func streamed(_ event: HatbotEvent?) {
    if awaitingSnapshot {
      awaitingSnapshot = false
      // An older brain opens with no snapshot: what's live is asked for instead.
      if case .snapshot = event {} else { Task { try? await loadLive() } }
    }
    if let event { apply(event) }
  }

  func apply(_ event: HatbotEvent) {
    switch event {
    // An older brain's delta doesn't say where it goes, so it can't tell whether the page has it. Progress
    // and usage aren't on the page.
    case .messageDelta(_, _, nil), .messageProgress, .messageUsage: break
    case .messageCreated, .messageDelta, .messageDone, .messageRewrite, .messageEdited, .messageSeen,
      .messageDeleted, .messageTask, .messageLink, .messageBox, .messageAttachment:
      for load in missed.keys { missed[load]?.append(event) }
    default: break
    }
    switch event {
    case let .snapshot(s):
      for b in s.bots { bots[b.id] = b }
      botIds = s.bots.map(\.id)
      conversations = s.conversations
      paused = s.paused
      take(approvals: s.approvals, questions: s.questions, desktop: s.desktop, unread: s.unread)
      computers = s.computers ?? []
      persist()
      prefetch()
      Task { await refreshTasks() }
    case let .messageCreated(m):
      if m.isIncognito { incognitoIds.insert(m.id) }
      if m.role == .assistant { refreshConversations() }
      follow(event)
      // What came of your own command arrives already seen.
      if m.role == .assistant && m.status != .streaming && m.seenAt == nil { addUnread(m.id) }
    case let .messageEdited(id, _):
      follow(event)
      addUnread(id)
      refreshConversations()
    case .messageRewrite, .messageDelta, .messageTask, .messageLink, .messageBox, .messageAttachment:
      follow(event)
    case let .messageSeen(ids, _):
      follow(event)
      unread.removeAll { ids.contains($0) }
      refreshConversations()
    case let .messageDeleted(ids):
      follow(event)
      unread.removeAll { ids.contains($0) }
    case let .messageProgress(id, text):
      if let r = live(id) { r.progress = String((r.progress + text).suffix(400)) }
    case let .messageUsage(id, used):
      live(id)?.usage = used
    case let .messageDone(id, _, _, _, _):
      follow(event)
      addUnread(id)
      refreshConversations()
    case let .spendUpdated(today, month):
      todayUsd = today
      monthUsd = month
    case let .memoryCommitted(_, message, author):
      if botIds.contains(where: { botName($0) == author }) || author == "Hatbot" { toast = "Memory: \(message)" }
      memoryVersion += 1
    case let .paused(value):
      paused = value
    case let .taskUpdated(task):
      tasks[task.id] = task
      if task.status != .running { taskProgress[task.id] = nil }
    case let .taskStep(step):
      guard var list = steps[step.taskId] else { return }
      if let i = list.firstIndex(where: { $0.id == step.id }) { list[i] = step } else { list.append(step) }
      steps[step.taskId] = list
    case let .taskProgress(taskId, text):
      taskProgress[taskId] = String(((taskProgress[taskId] ?? "") + text).suffix(400))
    case let .approvalCreated(a), let .approvalResolved(a):
      approvals[a.id] = a
    case let .questionCreated(q), let .questionResolved(q):
      questions[q.id] = q
    case let .desktopState(state):
      desktop = state
    case let .computers(list):
      computers = list
    case let .scheduleUpdated(s):
      schedules[s.id] = s
      deletedSchedules.remove(s.id)
    case let .scheduleDeleted(id):
      schedules[id] = nil
      deletedSchedules.insert(id)
    case let .triggerUpdated(t):
      triggers[t.id] = t
      deletedTriggers.remove(t.id)
    case let .triggerDeleted(id):
      triggers[id] = nil
      deletedTriggers.insert(id)
    case let .episodeUpdated(e):
      episodes[e.id] = e
    case let .botUpdated(b):
      bots[b.id] = b
      if !botIds.contains(b.id) { botIds.append(b.id) }
    case let .botDeleted(id):
      botGone(id)
      refreshConversations()
    case let .conversationUpdated(c):
      put(c)
    case let .conversationDeleted(id):
      chatGone(id)
    case let .proposalUpdated(p):
      proposals[p.id] = p
    case let .watcherUpdated(w):
      watchers[w.id] = w
    case .settingsUpdated:
      settingsVersion += 1
    case .heartbeatUpdated:
      heartbeatVersion += 1
    case let .watcherDeleted(id):
      watchers[id] = nil
      deletedWatchers.insert(id)
    case let .boxUpdated(b):
      boxes[b.id] = b
    case let .boxDeleted(id):
      boxes[id] = nil
      deletedBoxes.insert(id)
    case .unknown:
      break
    }
  }

  // MARK: Thread

  /// A message gets its conversation after it's posted; the POST's answer can land after that news and
  /// mustn't take it away again, or the message files under the folded conversation before it.
  private func upsert(_ m: ThreadMessage) {
    if let i = messages.firstIndex(where: { $0.id == m.id }) {
      var m = m
      m.episodeId = m.episodeId ?? messages[i].episodeId
      messages[i] = m
    } else {
      messages.append(m)
      messages.sort { $0.id < $1.id }
    }
  }

  func reply(_ id: Int) -> LiveReply? { replies[id] }

  func text(_ m: ThreadMessage) -> String {
    m.status == .streaming ? replies[m.id]?.text ?? m.text : m.text
  }

  /// The live reply for a streaming message, made here for one loaded mid-reply.
  private func live(_ id: Int) -> LiveReply? {
    if let r = replies[id] { return r }
    guard let m = messages.first(where: { $0.id == id }), m.status == .streaming else { return nil }
    let r = LiveReply(text: m.text)
    replies[id] = r
    return r
  }

  /// What a message's own events do to it, also on a page read before they came: a delta adds only what
  /// the reply doesn't have yet.
  private func follow(_ event: HatbotEvent) {
    func change(_ id: Int, _ body: (inout ThreadMessage) -> Void) {
      if let i = messages.firstIndex(where: { $0.id == id }) { body(&messages[i]) }
    }
    switch event {
    case let .messageCreated(m):
      guard m.isIncognito == incognito && (m.conversationId ?? 1) == conversationId else { return }
      if m.status == .streaming && replies[m.id] == nil { replies[m.id] = LiveReply(text: m.text) }
      upsert(m)
    case let .messageEdited(id, editedAt):
      change(id) { $0.editedAt = editedAt }
    case let .messageSeen(ids, seenAt):
      for i in messages.indices where ids.contains(messages[i].id) { messages[i].seenAt = seenAt }
    case let .messageDeleted(ids):
      for id in ids { replies[id] = nil }
      messages.removeAll { ids.contains($0.id) }
    case let .messageTask(id, taskId):
      change(id) { $0.taskId = taskId }
    case let .messageLink(id, link):
      change(id) { $0.link = link }
    case let .messageBox(id, boxId):
      change(id) { $0.boxId = boxId }
    case let .messageAttachment(id, a):
      change(id) { m in
        if !(m.attachments ?? []).contains(where: { $0.id == a.id }) { m.attachments = (m.attachments ?? []) + [a] }
      }
    case let .messageRewrite(id):
      // Its task ended: its bot is writing it again.
      if let i = messages.firstIndex(where: { $0.id == id }) {
        replies[id] = LiveReply(text: "")
        messages[i].text = ""
        messages[i].status = .streaming
      }
    case let .messageDelta(id, text, at):
      if let r = live(id) { r.text = Delta.added(text, to: r.text, at: at) }
    case let .messageDone(id, text, status, sources, choices):
      replies[id] = nil
      if let i = messages.firstIndex(where: { $0.id == id }) {
        messages[i].text = text
        messages[i].status = status
        if let sources { messages[i].sources = sources }
        if let choices { messages[i].choices = choices }
      }
    default: break
    }
  }

  /// After loading the latest page: its streaming replies start again from the text the brain sent.
  private func syncReplies(_ page: [ThreadMessage]) {
    for m in page {
      if m.status != .streaming {
        replies[m.id] = nil
      } else if let r = replies[m.id] {
        r.text = m.text
      } else {
        replies[m.id] = LiveReply(text: m.text)
      }
    }
    let shown = Set(messages.map(\.id))
    for id in replies.keys where !shown.contains(id) { replies[id] = nil }
  }

  private func addUnread(_ id: Int) {
    guard !unread.contains(id), !incognitoIds.contains(id) else { return }
    unread.append(id)
    unread.sort()
  }

  /// You've seen these messages: they stop counting as unread here and on your other devices.
  /// Rows that come into view together are told in one request.
  func markSeen(_ ids: [Int]) {
    let seen = ids.filter { unread.contains($0) }
    guard !seen.isEmpty else { return }
    unread.removeAll { seen.contains($0) }
    seenQueue += seen
    guard seenFlush == nil else { return }
    seenFlush = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(200))
      await self?.flushSeen()
    }
  }

  private func flushSeen() async {
    let ids = seenQueue
    seenQueue = []
    seenFlush = nil
    struct Body: Encodable { let ids: [Int] }
    // The brain takes up to 200 at a time.
    for start in stride(from: 0, to: ids.count, by: 200) {
      let chunk = Array(ids[start..<min(start + 200, ids.count)])
      let _: Empty? = try? await api.post("/thread/seen", body: Body(ids: chunk))
    }
  }

  /// A bot deleted, here or elsewhere: its own chat goes with it.
  private func botGone(_ id: String) {
    botIds.removeAll { $0 == id }
    for c in conversations where c.kind == .direct && c.botIds.first == id { chatGone(c.id) }
  }

  /// A chat deleted, here or elsewhere. If it's the one you're in, back to Hatbot's own chat, keeping none of it.
  private func chatGone(_ id: Int) {
    conversations.removeAll { $0.id == id }
    let gone = [id] + threads.values.filter { $0.parentId == id }.map(\.id)
    for t in gone {
      threads[t] = nil
      cache?.forget(t)
    }
    if gone.contains(conversationId) {
      messages = []
      threadKnown = false
      Task { await openConversation(1) }
    }
  }

  /// The chat's API path; a brain from before bots has only the one, /thread.
  private var chatPath: String { conversations.isEmpty ? "/thread" : "/conversations/\(conversationId)" }

  private func page(before: Int? = nil) -> String {
    "\(chatPath)/messages?limit=\(Self.page)" + (before.map { "&before=\($0)" } ?? "") + (incognito ? "&incognito=1" : "")
  }

  func loadThread() async throws {
    let wasIncognito = incognito
    let shown = conversationId
    let since = Self.current(messages)
    let load = UUID()
    missed[load] = []
    defer { missed[load] = nil }
    let list: [ThreadMessage] = try await api.get(page())
    // Switched while it loaded: the other conversation's load wins.
    guard wasIncognito == incognito, shown == conversationId else { return }
    (messages, hasEarlier) = ThreadMerge.merge(messages, hasEarlier: hasEarlier, latest: list, page: Self.page)
    threadKnown = true
    threadError = nil
    syncReplies(list)
    for event in missed.removeValue(forKey: load) ?? [] { follow(event) }
    // The messages show first; a fold says its first message until its recap comes.
    try? await loadEpisodes(list)
    persist()
    guard let since, let floor = list.first?.id, let from = messages.first?.id, from < floor else { return }
    do {
      try await refreshEarlier(from: from, before: floor, since: since)
    } catch let e as APIError where e.status == 404 {
      // A brain from before: they stay as they were.
    } catch {
      // Not known to be current, and the next load couldn't tell since when: they load again from the brain.
      guard wasIncognito == incognito, shown == conversationId else { return }
      messages.removeAll { $0.id < floor }
      hasEarlier = true
    }
  }

  /// A time the loaded messages were all current at, in the brain's clock: your bots' messages come only
  /// while the stream is up, and their times and edits are no later than when it went down. Yours may
  /// have been posted after.
  private static func current(_ list: [ThreadMessage]) -> String? {
    list.filter { $0.role == .assistant }.map { max($0.createdAt, $0.editedAt ?? "") }.max() ?? list.first?.createdAt
  }

  /// Earlier pages you'd loaded, brought up to date without loading them again: what was deleted meanwhile
  /// goes, and what a task's result edited is replaced.
  private func refreshEarlier(from: Int, before: Int, since: String) async throws {
    let wasIncognito = incognito
    let shown = conversationId
    let load = UUID()
    missed[load] = []
    defer { missed[load] = nil }
    let changes: MessageChanges = try await api.get(
      "\(chatPath)/messages/changes?from=\(from)&before=\(before)&since=\(API.query(since))"
        + (incognito ? "&incognito=1" : ""))
    guard wasIncognito == incognito, shown == conversationId else { return }
    let kept = Set(changes.ids)
    let changed = Dictionary(changes.changed.map { ($0.id, $0) }) { a, _ in a }
    messages = messages.compactMap { m in
      guard m.id >= from && m.id < before else { return m }
      return kept.contains(m.id) ? changed[m.id] ?? m : nil
    }
    syncReplies(changes.changed)
    for event in missed.removeValue(forKey: load) ?? [] { follow(event) }
  }

  @discardableResult
  func reloadThread() async -> Bool {
    let wasIncognito = incognito
    let shown = conversationId
    do {
      try await loadThread()
      return true
    } catch {
      // A load for the chat you've left fails on its own.
      if wasIncognito == incognito && shown == conversationId { threadError = error }
      return false
    }
  }

  /// Leaving incognito deletes its conversation.
  func setIncognito(_ on: Bool) async {
    guard on != incognito else { return }
    incognito = on
    messages = []
    hasEarlier = false
    threadKnown = false
    threadError = nil
    if !on { let _: Empty? = try? await api.delete("\(chatPath)/incognito") }
    await reloadThread()
  }

  /// Leaving one in incognito deletes its conversation.
  @discardableResult
  func openConversation(_ id: Int) async -> Bool {
    guard id != conversationId else { return true }
    let left = chatPath
    let wasIncognito = incognito
    // Read before the chat you leave is written: the cache's reads wait for its writes.
    let cached = cache?.page(id)
    persist()
    // Kept just now: the next look at the chat list checks it against that.
    prefetched[conversationId] = nil
    visited.insert(id)
    conversationId = id
    incognito = false
    messages = cached?.messages ?? []
    hasEarlier = cached?.hasEarlier ?? false
    threadKnown = cached != nil
    for e in cached?.episodes ?? [] { episodes[e.id] = e }
    // Its task cards show as they were kept, and load again as they are now.
    let kept = (cached?.tasks ?? []).map(\.id).filter { tasks[$0] == nil }
    restore(cached?.tasks ?? [])
    if !kept.isEmpty { Task { _ = try? await loadCards(kept) } }
    threadError = nil
    if wasIncognito { let _: Empty? = try? await api.delete("\(left)/incognito") }
    return await reloadThread()
  }

  // MARK: Bots

  /// Bots and chats. A brain from before bots answers 404, and the app keeps to /thread.
  func loadBots() async {
    async let botsLoad: [Bot]? = try? api.get("/bots")
    async let chatsLoad: [Conversation]? = try? api.get("/conversations")
    guard let list = await botsLoad, let chats = await chatsLoad else { return }
    for b in list { bots[b.id] = b }
    botIds = list.map(\.id)
    conversations = chats
    persist()
    prefetch()
  }

  /// Keeps on disk the latest page of chats the list says have news (a newer last message, or more
  /// unread), so switching to one shows it at once. One chat at a time, and one pass at a time.
  func prefetch() {
    guard cache != nil, !closed else { return }
    guard !prefetching else {
      prefetchAgain = true
      return
    }
    prefetching = true
    Task {
      repeat {
        prefetchAgain = false
        for c in conversations where c.id != conversationId && !closed {
          // One that didn't come is tried again at the next look.
          let fetched = stale(c) ? await prefetch(c.id) : true
          if fetched { prefetched[c.id] = (c.lastMessageAt, c.unread) }
        }
      } while prefetchAgain && !closed
      prefetching = false
    }
  }

  private func stale(_ c: Conversation) -> Bool {
    guard let last = c.lastMessageAt else { return false }
    if let seen = prefetched[c.id] { return last != seen.last || c.unread > seen.unread }
    // Unread ones may have been edited since; the rest are current if the kept page has the last message.
    guard c.unread == 0, let kept = cache?.page(c.id)?.messages.last?.createdAt else { return true }
    return kept < last
  }

  private func prefetch(_ id: Int) async -> Bool {
    visited.remove(id)
    let path = "/conversations/\(id)"
    guard let list: [ThreadMessage] = try? await api.get("\(path)/messages?limit=\(Self.page)") else { return false }
    // Finished messages only, as `persist` keeps: one still streaming would come back half written.
    let page = list.filter { $0.status != .streaming }
    let ids = Set(page.compactMap(\.episodeId))
    var recaps = ids.compactMap { episodes[$0] }
    let missing = ids.filter { episodes[$0] == nil }.sorted()
    if !missing.isEmpty,
      let found: [Episode] = try? await api.get("\(path)/episodes?ids=" + missing.map(String.init).joined(separator: ","))
    {
      recaps += found
    }
    // Opened meanwhile, it kept a newer page of its own; deleted, or signed out, it keeps none.
    guard !closed, id != conversationId, !visited.contains(id), conversations.contains(where: { $0.id == id })
    else { return false }
    let taskIds = Set(page.compactMap(\.taskId))
    cache?.save(
      DiskCache.Page(
        messages: page, episodes: recaps, hasEarlier: list.count == Self.page,
        tasks: taskIds.compactMap { tasks[$0]?.card }),
      for: id)
    return true
  }

  /// The chats' unread counts, soon: news comes in bursts. One load at a time, so an older answer
  /// can't land after a newer one; news meanwhile loads them once more.
  private func refreshConversations() {
    guard !conversations.isEmpty else { return }
    guard !refreshing else {
      refreshAgain = true
      return
    }
    refreshing = true
    Task {
      repeat {
        refreshAgain = false
        try? await Task.sleep(for: refreshDelay)
        if let chats: [Conversation] = try? await api.get("/conversations") { conversations = chats }
        // A thread's latest message and unread count.
        let parent = currentChat?.parentId ?? conversationId
        if threads.values.contains(where: { $0.parentId == parent }) { try? await loadThreads(parent) }
      } while refreshAgain
      refreshing = false
      prefetch()
    }
  }

  func botName(_ id: String?) -> String {
    guard let id else { return "" }
    return bots[id]?.name ?? (id == Bot.hatbot ? "Hatbot" : id)
  }

  func chatName(_ c: Conversation?) -> String {
    guard let c else { return "Hatbot" }
    if c.kind == .group { return c.title ?? c.botIds.map(botName).joined(separator: ", ") }
    if c.kind == .thread { return c.title ?? "Thread" }
    return botName(c.botIds.first)
  }

  var currentChat: Conversation? { conversations.first { $0.id == conversationId } ?? threads[conversationId] }

  /// The chat the list shows as open: a thread's own chat while you're in the thread.
  var listedChatId: Int { currentChat?.parentId ?? conversationId }

  // MARK: Threads

  /// Its bot marked it, or an approval or a question waits in it.
  func threadNeedsYou(_ t: Conversation) -> Bool {
    t.needsYou == true
      || approvals.values.contains { $0.status == .pending && $0.conversationId == t.id }
      || questions.values.contains { $0.status == .pending && $0.conversationId == t.id }
  }

  func loadThreads(_ parentId: Int) async throws {
    let list: [Conversation] = try await api.get("/conversations/\(parentId)/threads")
    for (id, t) in threads where t.parentId == parentId { threads[id] = nil }
    for t in list { threads[t.id] = t }
  }

  /// A thread a link or a card names, loaded first if it isn't known.
  @discardableResult
  func openThread(_ id: Int) async -> Bool {
    if threads[id] == nil {
      guard let c: Conversation = try? await api.get("/conversations/\(id)"), c.isThread else { return false }
      put(c)
    }
    return await openConversation(id)
  }

  func resolveThread(_ id: Int) async throws {
    let c: Conversation = try await api.post("/conversations/\(id)/resolve", body: Empty())
    put(c)
  }

  /// A thread that starts with this message of the bot's, or this ended task's card.
  func replyInThread(_ m: ThreadMessage) async throws {
    struct Body: Encodable { let messageId: Int }
    let c: Conversation = try await api.post(
      "/conversations/\(m.conversationId ?? conversationId)/threads", body: Body(messageId: m.id))
    put(c)
    await openConversation(c.id)
  }

  /// nil model, effort or plugins: as in Settings, every plugin.
  struct BotChange: Encodable, Sendable {
    var name: String?
    var instructions: String
    var chatModel: AppSettings.ModelID?
    var chatEffort: AppSettings.Effort?
    var plugins: [String]?
    /// nil: left as it is, or for a new bot, the brain picks.
    var icon: Bot.Icon?
    var color: Bot.Tint?

    private enum Key: String, CodingKey { case name, instructions, chatModel, chatEffort, plugins, icon, color }

    /// nil is sent as null, which means "as in Settings", except for the name.
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: Key.self)
      try c.encodeIfPresent(name, forKey: .name)
      try c.encode(instructions, forKey: .instructions)
      try c.encode(chatModel, forKey: .chatModel)
      try c.encode(chatEffort, forKey: .chatEffort)
      try c.encode(plugins, forKey: .plugins)
      try c.encodeIfPresent(icon, forKey: .icon)
      try c.encodeIfPresent(color, forKey: .color)
    }
  }

  func createBot(_ change: BotChange) async throws -> Bot {
    let b: Bot = try await api.post("/bots", body: change)
    bots[b.id] = b
    await loadBots()
    return b
  }

  @discardableResult
  func saveBot(_ id: String, _ change: BotChange) async throws -> Bot {
    let b: Bot = try await api.patch("/bots/\(id)", body: change)
    bots[b.id] = b
    return b
  }

  /// A bot whole: the list's may be brief.
  func loadBot(_ id: String) async throws -> Bot {
    let b: Bot = try await api.get("/bots/\(id)")
    bots[b.id] = b
    return b
  }

  func deleteBot(_ id: String) async throws {
    let _: Empty = try await api.delete("/bots/\(id)")
    botGone(id)
    await loadBots()
  }

  struct GroupChange: Encodable, Sendable {
    var title: String
    var botIds: [String]
  }

  func createGroup(_ change: GroupChange) async throws -> Conversation {
    let c: Conversation = try await api.post("/conversations", body: change)
    put(c)
    return c
  }

  func saveGroup(_ id: Int, _ change: GroupChange) async throws {
    let c: Conversation = try await api.patch("/conversations/\(id)", body: change)
    put(c)
  }

  func deleteGroup(_ id: Int) async throws {
    let _: Empty = try await api.delete("/conversations/\(id)")
    chatGone(id)
  }

  private func put(_ c: Conversation) {
    guard c.kind != .thread else {
      threads[c.id] = c
      return
    }
    if let i = conversations.firstIndex(where: { $0.id == c.id }) { conversations[i] = c } else { conversations.append(c) }
  }

  func loadPluginNames() async throws -> [PluginName] {
    try await api.get("/plugins")
  }

  /// None on a brain from before templates.
  func loadBotTemplates() async -> [BotTemplate] {
    (try? await api.get("/bot-templates")) ?? []
  }

  func loadEarlier() async throws {
    guard let first = messages.first, !loadingEarlier else { return }
    let shown = conversationId
    let wasIncognito = incognito
    loadingEarlier = true
    defer { loadingEarlier = false }
    let older: [ThreadMessage] = try await api.get(page(before: first.id))
    // Another chat, or in or out of incognito, while it loaded: the page belongs to the one you left.
    guard shown == conversationId, wasIncognito == incognito, messages.first?.id == first.id else { return }
    // Only now, with the rows: held at the bottom while the page loads, the chat would follow a reply
    // streaming in below your place.
    prepending = true
    defer { settle() }
    messages = older + messages
    hasEarlier = older.count == Self.page
    try? await loadEpisodes(older)
  }

  func reveal(_ id: Int) async -> Bool {
    if messages.isEmpty { try? await loadThread() }
    for _ in 0..<40 {
      if messages.contains(where: { $0.id == id }) { return true }
      guard hasEarlier, let first = messages.first?.id, id < first else { return false }
      while loadingEarlier { try? await Task.sleep(for: .milliseconds(100)) }
      do { try await loadEarlier() } catch { return false }
    }
    return messages.contains { $0.id == id }
  }

  /// The earlier page and its recaps stay "prepending" until they're laid out, so the chat keeps your
  /// place under them.
  private func settle() {
    settling?.cancel()
    settling = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(500))
      if !Task.isCancelled { self?.prepending = false }
    }
  }

  /// Writes an errored reply again: message.rewrite, then its deltas, follow. Only the latest one can be.
  func retry(_ messageId: Int) async throws {
    let _: Empty = try await api.post("\(chatPath)/messages/\(messageId)/retry", body: Empty())
  }

  /// Deletes a conversation from the chat for good; message.deleted takes it off the screen.
  func deleteEpisode(_ id: Int) async throws {
    let _: Empty = try await api.delete("\(chatPath)/episodes/\(id)")
  }

  /// A brain from before folds answers 404.
  private func loadEpisodes(_ list: [ThreadMessage]) async throws {
    let ids = Set(list.compactMap(\.episodeId)).filter { episodes[$0] == nil }.sorted()
    guard !ids.isEmpty else { return }
    let found: [Episode] = try await api.get("\(chatPath)/episodes?ids=" + ids.map(String.init).joined(separator: ","))
    for e in found { episodes[e.id] = e }
  }

  func send(_ text: String, attachmentIds: [Int] = []) async throws {
    struct Body: Encodable {
      let text: String
      let attachmentIds: [Int]
      let incognito: Bool
    }
    let m: ThreadMessage = try await api.post(
      "\(chatPath)/messages", body: Body(text: text, attachmentIds: attachmentIds, incognito: incognito))
    guard m.isIncognito == incognito && (m.conversationId ?? 1) == conversationId else { return }
    upsert(m)
    // A load on its way may have read the page before this was posted, and with the stream down no
    // event brings it.
    for load in missed.keys { missed[load]?.append(.messageCreated(m)) }
  }

  func upload(_ data: Data, name: String, mediaType: String) async throws -> Attachment {
    try await api.upload("/attachments", data: data, name: name, mediaType: mediaType)
  }

  // MARK: Tasks and approvals

  /// `since`: only the steps after the ones we have; a brain from before sends all.
  func loadTask(_ id: Int, since: Bool = false) async throws {
    let after = since ? steps[id]?.last?.id : nil
    let res: TaskWithSteps = try await api.get("/tasks/\(id)" + (after.map { "?afterStep=\($0)" } ?? ""))
    tasks[id] = res.task
    staleTasks.remove(id)
    if after == nil {
      steps[id] = res.steps
    } else {
      let fresh = Set(res.steps.map(\.id))
      steps[id] = ((steps[id] ?? []).filter { !fresh.contains($0.id) } + res.steps).sorted { $0.id < $1.id }
    }
    taskFiles[id] = res.attachments ?? []
  }

  @discardableResult
  private func loadCards(_ ids: [Int]) async throws -> [AgentTask] {
    let list: [AgentTask] = try await api.get(
      "/tasks?ids=\(ids.map(String.init).joined(separator: ","))&view=card")
    take(list)
    return list
  }

  private func take(_ list: [AgentTask]) {
    for t in list {
      tasks[t.id] = t.keeping(tasks[t.id])
      staleTasks.remove(t.id)
    }
  }

  /// After time away: the new steps of the running tasks the live view follows, and the rest that are
  /// running, or shown from disk, as they are now.
  func refreshTasks() async {
    let followed = tasks.values.filter { steps[$0.id] != nil && $0.isActive }.map(\.id)
    let running = tasks.values.filter { steps[$0.id] == nil && $0.isActive }.map(\.id)
    let others = Set(running).union(staleTasks).sorted()
    await withTaskGroup(of: Void.self) { group in
      for id in followed { group.addTask { try? await self.loadTask(id, since: true) } }
      for start in stride(from: 0, to: others.count, by: 200) {
        let some = Array(others[start..<min(start + 200, others.count)])
        group.addTask { _ = try? await self.loadCards(some) }
      }
    }
  }

  /// The rows that appear together come in one request.
  func ensureTask(_ id: Int) {
    if tasks[id] != nil { return }
    guard requested.insert("t\(id)").inserted else { return }
    wantedTasks.append(id)
    guard wantedTasks.count == 1 else { return }
    Task { await loadWantedTasks() }
  }

  private func loadWantedTasks() async {
    let ids = wantedTasks
    wantedTasks = []
    for start in stride(from: 0, to: ids.count, by: 200) {
      let some = Array(ids[start..<min(start + 200, ids.count)])
      do {
        let list = try await loadCards(some)
        // A brain from before ids= sends its newest tasks instead: the rest one at a time.
        guard list.contains(where: { !some.contains($0.id) }) else { continue }
        for id in some where tasks[id] == nil {
          do { try await loadTask(id) } catch { requested.remove("t\(id)") }
        }
      } catch {
        for id in some { requested.remove("t\(id)") }
      }
    }
  }

  func ensureSteps(_ id: Int) {
    if steps[id] != nil { return }
    guard requested.insert("st\(id)").inserted else { return }
    Task {
      do { try await loadTask(id) } catch { requested.remove("st\(id)") }
    }
  }

  func ensureApproval(_ id: Int) {
    if approvals[id] != nil { return }
    guard requested.insert("a\(id)").inserted else { return }
    Task {
      do {
        let a: Approval = try await api.get("/approvals/\(id)")
        approvals[a.id] = a
      } catch { requested.remove("a\(id)") }
    }
  }

  func ensureSchedule(_ id: Int) {
    if schedules[id] != nil || deletedSchedules.contains(id) { return }
    guard requested.insert("s\(id)").inserted else { return }
    Task {
      do {
        let s: Schedule = try await api.get("/schedules/\(id)")
        schedules[s.id] = s
      } catch let error as APIError where error.status == 404 {
        deletedSchedules.insert(id)
      } catch { requested.remove("s\(id)") }
    }
  }

  func ensureBox(_ id: Int) {
    if boxes[id] != nil || deletedBoxes.contains(id) { return }
    guard requested.insert("x\(id)").inserted else { return }
    Task {
      do {
        _ = try await loadBox(id)
      } catch let error as APIError where error.status == 404 {
      } catch { requested.remove("x\(id)") }
    }
  }

  enum TaskFilter: String {
    case active, done
  }

  /// The ids of a page of the tasks in a list, newest first; `before` a task's id, the page after it.
  /// A page is `AppStore.page` long; a shorter one is the last.
  func loadTasks(_ filter: TaskFilter, before: Int? = nil) async throws -> [Int] {
    let list: [AgentTask] = try await api.get(
      "/tasks?status=\(filter.rawValue)&view=card" + (before.map { "&before=\($0)" } ?? ""))
    take(list)
    if before == nil && !closed { cache?.save(tasks: list.map(\.card), filter.rawValue) }
    return list.map(\.id)
  }

  func cachedTasks(_ filter: TaskFilter) -> [Int]? {
    guard let list = cache?.tasks(filter.rawValue) else { return nil }
    restore(list)
    return list.map(\.id)
  }

  /// For a brain whose stream doesn't open with a snapshot. All at once: none of these waits on another.
  func loadLive() async throws {
    let api = self.api
    async let chats: Void = loadBots()
    async let approvalsLoad: [Approval] = api.get("/approvals?pending=1")
    // A brain from before questions answers 404.
    async let questionsLoad: [Question]? = try? api.get("/questions")
    async let stateLoad: DesktopState? = try? api.get("/desktop/status")
    // A brain from before unread answers 404.
    async let unreadLoad: [Int]? = try? api.get("/thread/unread")
    async let computersLoad: [ComputerInfo]? = try? api.get("/computers")
    async let taskLoads: Void = refreshTasks()
    let pending = try await approvalsLoad
    let state = await stateLoad
    take(approvals: pending, questions: await questionsLoad, desktop: state, unread: await unreadLoad)
    computers = await computersLoad ?? []
    _ = await (chats, taskLoads)
  }

  /// Anything we thought pending but the brain doesn't list was decided meanwhile.
  private func take(
    approvals pending: [Approval], questions asked: [Question]?, desktop state: DesktopState?, unread list: [Int]?
  ) {
    for a in approvals.values where a.status == .pending {
      requested.remove("a\(a.id)")
      if !pending.contains(where: { $0.id == a.id }) { approvals[a.id] = nil }
    }
    for a in pending { approvals[a.id] = a }
    // Those answered or dropped meanwhile aren't listed.
    if let asked { questions = Dictionary(uniqueKeysWithValues: asked.map { ($0.id, $0) }) }
    desktop = state
    if let list { unread = list }
  }

  /// `scope`: one the approval offers, to approve it beyond this once.
  func decide(_ id: Int, _ decision: Decision, note: String = "", scope: String? = nil) async throws {
    struct Body: Encodable {
      let decision: Decision
      let note: String?
      let scope: String?
    }
    let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    let body = Body(decision: decision, note: trimmed.isEmpty ? nil : trimmed, scope: scope)
    let a: Approval = try await api.post("/approvals/\(id)", body: body)
    approvals[a.id] = a
  }

  func answer(_ id: Int, _ answer: String) async throws {
    struct Body: Encodable { let answer: String }
    let q: Question = try await api.post("/questions/\(id)", body: Body(answer: answer))
    questions[q.id] = q
  }

  func cancelTask(_ id: Int) async throws {
    try await api.post("/tasks/\(id)/cancel")
  }

  /// You trust what a conversation read: its changes no longer ask because of it.
  func trustConversation(_ conversationId: Int, episode: Int) async throws {
    try await api.post("/conversations/\(conversationId)/episodes/\(episode)/trust")
  }

  // MARK: Desktop

  /// `screen`: one of your computers; the desktop by default.
  func takeover(_ screen: String? = nil) async throws {
    if let screen {
      putComputer(try await api.post("/computers/\(screen)/takeover", body: Empty()))
    } else {
      desktop = try await api.post("/desktop/takeover", body: Empty())
    }
  }

  func handback(_ screen: String? = nil) async throws {
    if let screen {
      putComputer(try await api.post("/computers/\(screen)/handback", body: Empty()))
    } else {
      desktop = try await api.post("/desktop/handback", body: Empty())
    }
  }

  private func putComputer(_ c: ComputerInfo) {
    if let i = computers.firstIndex(where: { $0.id == c.id }) { computers[i] = c }
  }

  /// The live view's socket: JPEG frames out, your input in while you have control.
  func liveSocket(_ screen: String? = nil) -> Socket {
    let api = self.api
    let path = screen.map { "/computer/live/\($0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? $0)" }
    let socket = Socket(maxDelay: 15) { api.webSocket(path ?? "/desktop/live") }
    socket.onUnauthorized = { api.unauthorized() }
    return socket
  }

  // MARK: Schedules and triggers

  func loadSchedules() async throws {
    async let s: [Schedule] = api.get("/schedules")
    async let t: [Trigger] = api.get("/triggers")
    let (list, hooks) = try await (s, t)
    schedules = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    triggers = Dictionary(uniqueKeysWithValues: hooks.map { ($0.id, $0) })
  }

  func loadSchedule(_ id: Int) async throws {
    schedules[id] = try await api.get("/schedules/\(id)")
  }

  func loadTrigger(_ id: Int) async throws {
    triggers[id] = try await api.get("/triggers/\(id)")
  }

  /// A change to a schedule; nil fields stay as they are. Give `cron` or `at`, not both.
  struct ScheduleChange: Encodable, Sendable {
    var name: String?
    var prompt: String?
    var enabled: Bool?
    var cron: String?
    /// ISO 8601 date and time, for a one-off run.
    var at: String?
    var botId: String?
  }

  @discardableResult
  func saveSchedule(_ id: Int, _ change: ScheduleChange) async throws -> Schedule {
    let s: Schedule = try await api.patch("/schedules/\(id)", body: change)
    schedules[s.id] = s
    return s
  }

  func createSchedule(_ change: ScheduleChange) async throws -> Schedule {
    let s: Schedule = try await api.post("/schedules", body: change)
    schedules[s.id] = s
    return s
  }

  func runSchedule(_ id: Int) async throws -> AgentTask {
    let task: AgentTask = try await api.post("/schedules/\(id)/run", body: Empty())
    tasks[task.id] = task
    return task
  }

  func deleteSchedule(_ id: Int) async throws {
    let _: Empty = try await api.delete("/schedules/\(id)")
    schedules[id] = nil
    deletedSchedules.insert(id)
  }

  struct TriggerChange: Encodable, Sendable {
    var name: String?
    var prompt: String?
    var trusted: Bool?
    var enabled: Bool?
    var confirmChecks: Int?
    var botId: String?
  }

  @discardableResult
  func saveTrigger(_ id: Int, _ change: TriggerChange) async throws -> Trigger {
    let t: Trigger = try await api.patch("/triggers/\(id)", body: change)
    triggers[t.id] = t
    return t
  }

  /// A new secret; the old one stops working at once.
  func newTriggerSecret(_ id: Int) async throws -> TriggerWithSecret {
    let t: TriggerWithSecret = try await api.post("/triggers/\(id)/secret", body: Empty())
    triggers[id] = t.trigger
    return t
  }

  func deleteTrigger(_ id: Int) async throws {
    let _: Empty = try await api.delete("/triggers/\(id)")
    triggers[id] = nil
    deletedTriggers.insert(id)
  }

  // MARK: Memory

  func showKeptMemory() {
    if memoryFiles == nil { memoryFiles = cache?.memoryTree() }
  }

  @discardableResult
  func memoryTree() async throws -> [MemoryFile] {
    let files: [MemoryFile] = try await api.get("/memory/tree")
    memoryFiles = files
    memoryFilesLoaded = true
    if !closed { cache?.save(memoryTree: files) }
    return files
  }

  func showKeptTodos() {
    if todos == nil { todos = cache?.todos() }
  }

  func keep(_ list: TodoList) {
    todos = list
    if !closed { cache?.save(list) }
  }

  struct MemoryFileContent: Decodable, Sendable {
    let content: String
    /// What to save on top of; missing on brains from before conflict checks.
    let sha: String?
  }

  func memoryFile(_ path: String) async throws -> MemoryFileContent {
    try await api.get("/memory/file?path=\(API.query(path))")
  }

  /// A save refused because the file changed since it was read (or, for a new one, is already there):
  /// what it is now.
  struct MemoryConflict: Error, Decodable, Equatable, Sendable {
    let sha: String
    let content: String
  }

  /// Saves a file as you, on top of the version `baseSha` names ("" for a new file; nil saves over
  /// whatever is there). Returns the commit, or nil if nothing changed; throws MemoryConflict when it
  /// changed meanwhile, and writes nothing.
  @discardableResult
  func saveMemoryFile(_ path: String, content: String, baseSha: String?) async throws -> String? {
    struct Body: Encodable {
      let content: String
      let message: String
      let baseSha: String?
    }
    struct Saved: Decodable { let sha: String? }
    let r: Saved
    do {
      r = try await api.put(
        "/memory/file?path=\(API.query(path))", body: Body(content: content, message: "Edit \(path)", baseSha: baseSha))
    } catch let e as APIError where e.status == 409 {
      if let now = try? JSONDecoder().decode(MemoryConflict.self, from: e.body) { throw now }
      throw e
    }
    memoryVersion += 1
    return r.sha
  }

  func deleteMemoryFile(_ path: String) async throws {
    let _: Empty = try await api.delete("/memory/file?path=\(API.query(path))")
    memoryVersion += 1
  }

  func memoryLog(path: String? = nil) async throws -> [MemoryCommit] {
    try await api.get("/memory/log?limit=100" + (path.map { "&path=\(API.query($0))" } ?? ""))
  }

  func memoryDiff(_ sha: String) async throws -> String {
    struct Diff: Decodable { let diff: String }
    let d: Diff = try await api.get("/memory/diff/\(sha)")
    return d.diff
  }

  /// Undoes a commit with a new one; returns it, or nil if there was nothing to undo.
  func revert(_ sha: String) async throws -> String? {
    struct Reverted: Decodable { let sha: String? }
    let r: Reverted = try await api.post("/memory/revert/\(sha)", body: Empty())
    memoryVersion += 1
    return r.sha
  }

  // MARK: Admin

  func setPaused(_ value: Bool) async throws {
    try await api.post(value ? "/pause-all" : "/resume")
    paused = value
  }

  func loadSpend() async throws -> SpendSummary {
    let s: SpendSummary = try await api.get("/spend/summary")
    todayUsd = s.todayUsd
    monthUsd = s.monthUsd
    return s
  }

  func loadSettings() async throws -> AppSettings {
    try await api.get("/settings")
  }

  /// A brain from before model providers were plugins has no /models: it offers Claude's.
  func loadModels() async -> [ModelOption] {
    let list: [ModelOption]? = try? await api.get("/models")
    return list ?? AppSettings.ModelID.known.map {
      ModelOption(id: $0.rawValue, name: $0.name, provider: "anthropic", computerUse: true)
    }
  }

  /// Settings to change; the ones left nil aren't sent, and stay as they are.
  struct SettingsChange: Encodable, Sendable {
    var limits: Limits?
    var chatEffort: AppSettings.Effort?
    var notificationsOpen: AppSettings.Opens?
    var desktopModel: AppSettings.ModelID?
    var desktopEscalate: Bool?
    var taskModel: AppSettings.ModelID?
    var chatModel: AppSettings.ModelID?
    var smallModel: AppSettings.ModelID?
    var expertModel: AppSettings.ModelID?
    var reviewChanges: Bool?
    var heartbeat: AppSettings.Heartbeat?
    var weeklyReport: AppSettings.WeeklyReport?
    var memoryTidy: Bool?
    var todoHour: Int?
  }

  func saveSettings(_ change: SettingsChange) async throws -> AppSettings {
    try await api.put("/settings", body: change)
  }
}
