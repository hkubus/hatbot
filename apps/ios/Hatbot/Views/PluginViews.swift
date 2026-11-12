import SwiftUI
import WebKit

extension View {
  /// A plugin's section, while that plugin is off, says so in its place, as on the web.
  func offWithItsPlugin(_ tab: AppTab) -> some View { modifier(PluginOff(tab: tab)) }
}

private struct PluginOff: ViewModifier {
  let tab: AppTab
  @Environment(AppStore.self) private var store

  @ViewBuilder
  func body(content: Content) -> some View {
    if let id = tab.plugin, !store.pluginOn(id) {
      NavigationStack {
        ContentUnavailableView {
          Label("\(store.plugins[id]?.name ?? tab.title) is off", systemImage: tab.icon)
        } description: {
          Text("Switch it on in Plugins, in the web app's settings.")
        }
        .navigationTitle(tab.title)
        .navigationBarTitleDisplayMode(.inline)
        .sidebarButton()
        .containerBackground(Color.surface, for: .navigation)
      }
    } else {
      content
    }
  }
}

/// An installed plugin's page. The app is built with only the first-party plugins' views, so it's the web
/// app's, signed in by a one-time link and shown without the web app's own bars.
struct PluginPageView: View {
  let id: String
  @Environment(AppStore.self) private var store
  @Environment(\.openURL) private var openURL
  @State private var address: URL?
  @State private var problem: String?
  @State private var tries = 0

  var body: some View {
    Group {
      if !store.plugins.isEmpty && store.plugins[id] == nil {
        ContentUnavailableView("That's gone.", systemImage: "puzzlepiece.extension")
      } else if let problem {
        ContentUnavailableView {
          Label(problem, systemImage: "exclamationmark.triangle")
        } description: {
          EmptyView()
        } actions: {
          Button("Reload") { tries += 1 }
        }
      } else if let address {
        PluginWebView(address: address, openURL: openURL, problem: $problem)
          .id(address)
          .ignoresSafeArea(edges: .bottom)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .navigationTitle(store.plugins[id]?.name ?? "Plugin")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: tries) {
      problem = nil
      address = nil
      do {
        address = try await store.api.webLink(to: "/settings/plugins/\(id)?embedded")
      } catch is CancellationError {
      } catch {
        problem = message(for: error)
      }
    }
  }
}

/// A data store that keeps nothing, so the sign-in goes with the view.
private struct PluginWebView: UIViewRepresentable {
  let address: URL
  let openURL: OpenURLAction
  @Binding var problem: String?

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = context.coordinator
    web.uiDelegate = context.coordinator
    // A link's preview would load its page inside the app.
    web.allowsLinkPreview = false
    // No white flash in dark mode before the page draws.
    web.isOpaque = false
    web.backgroundColor = .clear
    web.load(URLRequest(url: address))
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {
    context.coordinator.parent = self
  }

  /// The link's session ends with the page, rather than staying in Devices and tokens for 30 days. The task
  /// holds the web view until the brain answers.
  static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
    web.stopLoading()
    Task {
      _ = try? await web.callAsyncJavaScript(
        "await fetch('\(API.prefix)/auth/logout', {method: 'POST'})", contentWorld: .defaultClient)
    }
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var parent: PluginWebView

    init(parent: PluginWebView) { self.parent = parent }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard let url = action.request.url else { return .cancel }
      let link = action.navigationType == .linkActivated
      switch SitePage.decide(url, mainFrame: action.targetFrame?.isMainFrame, link: link, site: parent.address) {
      case .allow: return .allow
      case let .open(page): parent.openURL(page)
      case .refuse: break
      }
      return .cancel
    }

    /// `window.open`: the page opens in Safari, never in the app.
    func webView(
      _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if let url = action.request.url,
        case let .open(page) = SitePage.decide(url, mainFrame: nil, link: true, site: parent.address)
      {
        parent.openURL(page)
      }
      return nil
    }

    func webView(
      _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse
    ) async -> WKNavigationResponsePolicy {
      guard response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 else {
        return .allow
      }
      parent.problem = http.statusCode == 403 ? "This link has expired." : "Couldn't open this page."
      return .cancel
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      parent.problem = "This page stopped."
    }

    private func failed(_ error: Error) {
      let e = error as NSError
      // Refused here, which already says why, or stopped for a newer load.
      if parent.problem != nil || (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled)
        || (e.domain == "WebKitErrorDomain" && e.code == 102)
      {
        return
      }
      parent.problem = "Couldn't open this page."
    }
  }
}
