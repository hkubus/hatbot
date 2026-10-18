// Boxes (PLAN.md §21): the small web apps your bots made, and one as large as the screen allows, under
// Hatbot's navigation bar so it can't pass for the app's own screens. Its page runs in a web view of its
// own, on an opaque origin with no network, and what it saves goes through the app to the brain.
import SwiftUI
import UIKit
import WebKit

/// Every box, latest change first.
struct BoxesView: View {
  @Binding var path: [Route]
  @Environment(AppStore.self) private var store
  @State private var error: String?

  /// As loaded, then kept up to date by the event stream.
  private var boxes: [Box]? {
    store.boxesLoaded ? store.boxes.values.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) } : nil
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let error { Text(error).foregroundStyle(.red) }
        if let boxes, boxes.isEmpty {
          Text("No boxes yet. Ask Hatbot for a tracker, a calculator or a planner to keep.")
            .foregroundStyle(.secondary)
        }
        ForEach(boxes ?? []) { b in
          NavigationLink(value: Route.box(b.id)) {
            LabeledContent(b.title, value: b.updatedAt.stampText)
          }
        }
      }
      .overlay { if boxes == nil && error == nil { ProgressView() } }
      .navigationTitle("Boxes")
      .navigationBarTitleDisplayMode(.inline)
      .sidebarButton()
      .refreshable { await load() }
      .task { await load() }
      .routes()
    }
  }

  private func load() async {
    await attempt($error) { try await store.loadBoxes() }
  }
}

/// A box: its page, the version menu when there's more than one, Restore on an older version, Code and
/// Delete. The bot's changes show as they're made.
struct BoxView: View {
  let id: Int
  @Environment(AppStore.self) private var store
  @State private var detail: BoxDetail?
  @State private var notFound = false
  @State private var loadError: String?
  /// The version showing; nil for the current one, which follows the bot's changes.
  @State private var picked: Int?
  @State private var busy = false
  @State private var confirmDelete = false
  @State private var error: String?
  @State private var tries = 0

  private var missing: Bool { notFound || store.deletedBoxes.contains(id) }

  var body: some View {
    Group {
      if missing {
        ContentUnavailableView("This box was deleted.", systemImage: "shippingbox")
      } else if let detail {
        VStack(spacing: 0) {
          if let shown = error ?? loadError {
            Text(shown)
              .font(.footnote)
              .foregroundStyle(.red)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal)
              .padding(.vertical, 6)
          }
          BoxFrame(id: id, version: picked ?? detail.box.version)
        }
      } else if let loadError {
        ContentUnavailableView {
          Label(loadError, systemImage: "exclamationmark.triangle")
        } description: {
          EmptyView()
        } actions: {
          Button("Retry") { tries += 1 }
        }
      } else {
        ProgressView()
      }
    }
    .navigationTitle(detail?.box.title ?? store.boxes[id]?.title ?? "Box")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let detail, !missing { actions(detail) }
    }
    .confirmingDelete(
      "Delete this box? Every version and what it saved go with it.", isPresented: $confirmDelete, error: $error
    ) {
      try await store.deleteBox(id)
    }
    // Changed by its bot, here or elsewhere: read again, unless that's what was read last.
    .task(id: Reload(changed: store.boxes[id]?.updatedAt, tries: tries)) {
      if let detail, detail.box.updatedAt == store.boxes[id]?.updatedAt { return }
      await attempt($loadError, missing: $notFound) { detail = try await store.loadBox(id) }
    }
  }

  private struct Reload: Hashable {
    let changed: String?
    let tries: Int
  }

  @ToolbarContentBuilder
  private func actions(_ d: BoxDetail) -> some ToolbarContent {
    let version = picked ?? d.box.version
    if version != d.box.version {
      ToolbarItem {
        Button("Restore") { restore(version) }.disabled(busy)
      }
    }
    if d.versions.count > 1 {
      ToolbarItem {
        Menu {
          Picker("Version", selection: Binding(get: { version }, set: { picked = $0 == d.box.version ? nil : $0 })) {
            ForEach(Array(d.versions.reversed()), id: \.n) { v in
              Text("Version \(v.n), \(v.createdAt.stampText)").tag(v.n)
            }
          }
        } label: {
          Label("Version", systemImage: "clock.arrow.circlepath")
        }
      }
    }
    ToolbarItem(placement: .secondaryAction) {
      NavigationLink(value: Route.boxCode(id, version: version)) {
        Label("Code", systemImage: "chevron.left.forwardslash.chevron.right")
      }
    }
    ToolbarItem(placement: .secondaryAction) {
      Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }.disabled(busy)
    }
  }

  /// The older version's page as a new version, which then shows.
  private func restore(_ version: Int) {
    Task {
      busy = true
      await attempt($error) {
        detail = try await store.revertBox(id, to: version)
        picked = nil
      }
      busy = false
    }
  }
}

/// A version's page at the signed address the brain gives, asked for again on Reload.
private struct BoxFrame: View {
  let id: Int
  let version: Int
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.openURL) private var openURL
  @State private var opened: Opened?
  /// Why the page isn't showing: it left, its address expired, or it couldn't be opened.
  @State private var problem: String?
  @State private var tries = 0

  struct Opened: Equatable {
    let address: URL
    /// The appearance the address asked for.
    let dark: Bool
  }

  var body: some View {
    Group {
      if let problem {
        ContentUnavailableView {
          Label(problem, systemImage: "exclamationmark.triangle")
        } description: {
          EmptyView()
        } actions: {
          Button("Reload") { tries += 1 }
        }
      } else if let opened {
        BoxWebView(
          id: id, opened: opened, dark: scheme == .dark, store: store, openURL: openURL, problem: $problem
        )
        .id(opened.address)
        .ignoresSafeArea(edges: .bottom)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    // A new address for each version and each Reload; the appearance changes in place, keeping the page.
    .task(id: Load(version: version, tries: tries)) {
      problem = nil
      opened = nil
      let dark = scheme == .dark
      do {
        let address = try await store.boxAddress(id, version: version, dark: dark)
        opened = Opened(address: address, dark: dark)
      } catch is CancellationError {
      } catch {
        problem = message(for: error)
      }
    }
  }

  private struct Load: Hashable {
    let version: Int
    let tries: Int
  }
}

/// The page in a web view with a data store of its own that keeps nothing. WebKit's `hatbox` handler
/// answers the page's calls for this box only, and the web view never leaves the box's page: links to
/// web pages open in Safari (PLAN.md §21.8).
private struct BoxWebView: UIViewRepresentable {
  let id: Int
  let opened: BoxFrame.Opened
  /// The app's appearance now, which the page follows.
  let dark: Bool
  let store: AppStore
  let openURL: OpenURLAction
  @Binding var problem: String?

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    // The page's own world, where the script the brain puts at its top looks for the handler.
    config.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "hatbox")
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = context.coordinator
    web.uiDelegate = context.coordinator
    // A link's preview would load its page inside the app.
    web.allowsLinkPreview = false
    // No white flash in dark mode before the page draws.
    web.isOpaque = false
    web.backgroundColor = .clear
    context.coordinator.web = web
    web.load(URLRequest(url: opened.address))
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.followTheme()
  }

  static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
    web.stopLoading()
    web.configuration.userContentController.removeAllScriptMessageHandlers()
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var parent: BoxWebView
    weak var web: WKWebView?
    /// The box's page has come: from then on it moves only within itself.
    private var loaded = false
    /// It has finished loading, so its script is there to take the appearance.
    private var ready = false
    /// The appearance the page has.
    private var dark: Bool

    init(parent: BoxWebView) {
      self.parent = parent
      dark = parent.opened.dark
    }

    private var address: URL { parent.opened.address }

    /// Tells the page the app's appearance changed.
    func followTheme() {
      guard ready, parent.problem == nil, parent.dark != dark else { return }
      dark = parent.dark
      web?.evaluateJavaScript("window.__hatboxTheme(\(dark))", in: nil, in: .page) { _ in }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard let url = action.request.url else { return .cancel }
      let link = action.navigationType == .linkActivated
      switch BoxNavigation.decide(
        url, mainFrame: action.targetFrame?.isMainFrame, link: link, address: address, loaded: loaded)
      {
      case .allow: return .allow
      case let .open(page): parent.openURL(page)
      case .refuse: break
      case .leave: parent.problem = "This box left its page."
      }
      return .cancel
    }

    /// `window.open`: the page opens in Safari, never in the app.
    func webView(
      _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if let url = action.request.url,
        case let .open(page) = BoxNavigation.decide(url, mainFrame: nil, link: true, address: address, loaded: loaded)
      {
        parent.openURL(page)
      }
      return nil
    }

    func webView(
      _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse
    ) async -> WKNavigationResponsePolicy {
      guard response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode != 200 else {
        return .allow
      }
      parent.problem = http.statusCode == 403 ? "This link has expired." : "Couldn't open this box."
      return .cancel
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
      loaded = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      ready = true
      // The appearance may have changed while the page loaded.
      followTheme()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      parent.problem = "This box stopped."
    }

    private func failed(_ error: Error) {
      let e = error as NSError
      // Refused here, which already says why, or stopped for a newer load.
      if parent.problem != nil || (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled)
        || (e.domain == "WebKitErrorDomain" && e.code == 102)
      {
        return
      }
      parent.problem = "Couldn't open this box."
    }

    /// A call from `window.hatbox`, passed on as it is to the brain, which checks it: the answer's value,
    /// or the brain's error. Only the box's own page is answered, and only while it's showing.
    func userContentController(
      _ controller: WKUserContentController, didReceive script: WKScriptMessage
    ) async -> (Any?, String?) {
      guard parent.problem == nil, script.frameInfo.isMainFrame, script.webView === web,
        BoxNavigation.samePage(script.frameInfo.request.url, address)
      else { return (nil, "Open this box in Hatbot.") }
      guard let call = BoxBridge.json(script.body) else { return (nil, "That isn't a value a box can keep.") }
      do {
        let answer = try await parent.store.callBox(parent.id, json: call)
        return (BoxBridge.value(answer), nil)
      } catch {
        return (nil, message(for: error))
      }
    }
  }
}

/// A version's page as its source, read-only: a box with files shows them, one after another.
struct BoxCodeView: View {
  let id: Int
  let version: Int
  @Environment(AppStore.self) private var store
  @State private var html: String?
  @State private var error: String?
  @State private var tries = 0

  var body: some View {
    Group {
      if let html {
        SourceText(text: html).ignoresSafeArea(edges: .bottom)
      } else if let error {
        ContentUnavailableView {
          Label(error, systemImage: "exclamationmark.triangle")
        } description: {
          EmptyView()
        } actions: {
          Button("Retry") { tries += 1 }
        }
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Code")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: tries) {
      await attempt($error) { html = try await store.boxPage(id, version: version).source }
    }
  }
}

/// Selectable, read-only text, laid out as it scrolls: a box's page can be a megabyte, which a SwiftUI
/// Text would lay out whole.
private struct SourceText: UIViewRepresentable {
  let text: String

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    let mono = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    view.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: mono)
    view.adjustsFontForContentSizeCategory = true
    view.textColor = .label
    view.backgroundColor = .systemBackground
    view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    view.dataDetectorTypes = []
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    if view.text != text { view.text = text }
  }
}
