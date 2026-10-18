// Renders Hatbot's Markdown: blocks from Markdown.parse, inline formatting and links through
// AttributedString, charts through ChartView (those drawn from a file once the brain sends their
// values). Raw HTML is shown as text, never rendered.
import SwiftUI
import UIKit

struct MarkdownText: View {
  let text: String
  /// A reply still coming in: parsed again at most every 100 ms, not on every delta.
  var streaming = false
  @State private var throttle = Throttle()
  /// Bumped when a held-back parse is due.
  @State private var due = 0

  var body: some View {
    let _ = due
    let blocks = streaming ? throttle.blocks(text) { due += 1 } : Markdown.cached(text)
    VStack(alignment: .leading, spacing: 8) {
      ForEach(blocks.indices, id: \.self) { i in
        block(blocks[i])
      }
    }
    .textSelection(.enabled)
  }

  @ViewBuilder
  private func block(_ block: MDBlock) -> some View {
    switch block {
    case let .heading(level, text):
      Text(inline(text)).font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
    case let .paragraph(text):
      Text(inline(text))
    case let .list(items):
      VStack(alignment: .leading, spacing: 3) {
        ForEach(items.indices, id: \.self) { i in
          let item = items[i]
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(item.marker).monospacedDigit().foregroundStyle(.secondary)
            Text(inline(item.text))
          }
          .padding(.leading, CGFloat(item.depth) * 16)
        }
      }
    case let .quote(text):
      HStack(spacing: 10) {
        RoundedRectangle(cornerRadius: 1.5).fill(.tertiary).frame(width: 3)
        Text(inline(text)).foregroundStyle(.secondary)
      }
      .fixedSize(horizontal: false, vertical: true)
    case let .code(_, code):
      CodeBlock(code: code)
    case let .chart(spec):
      ChartView(spec: spec)
    case let .chartFile(file):
      FileChart(file: file)
    case .chartPending:
      ChartPlaceholder()
    case let .table(header, rows):
      ScrollView(.horizontal) {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
          GridRow { ForEach(header.indices, id: \.self) { Text(inline(header[$0])).bold() } }
          Divider()
          ForEach(rows.indices, id: \.self) { r in
            GridRow { ForEach(rows[r].indices, id: \.self) { Text(inline(rows[r][$0])) } }
          }
        }
        .font(.subheadline)
      }
    case .rule:
      Divider()
    }
  }

  private func inline(_ text: String) -> AttributedString {
    let key = NSString(string: text)
    if let hit = Self.inlines.object(forKey: key) { return hit.value }
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    Self.inlines.setObject(CacheBox(parsed), forKey: key)
    return parsed
  }

  nonisolated(unsafe) private static let inlines: NSCache<NSString, CacheBox<AttributedString>> = {
    let c = NSCache<NSString, CacheBox<AttributedString>>()
    c.countLimit = 2000
    return c
  }()

  /// The blocks of a streaming reply: parsed when 100 ms have passed since the last time, otherwise the
  /// last ones, with `due` called once the wait is over so the latest text gets parsed.
  @MainActor
  private final class Throttle {
    private var parsed: String?
    private var blocks: [MDBlock] = []
    private var last = Date.distantPast
    private var waiting = false

    func blocks(_ text: String, due: @escaping @MainActor () -> Void) -> [MDBlock] {
      if text == parsed { return blocks }
      let wait = 0.1 - Date().timeIntervalSince(last)
      if wait <= 0 || parsed == nil {
        parsed = text
        blocks = Markdown.parse(text)
        last = Date()
      } else if !waiting {
        waiting = true
        Task { @MainActor in
          try? await Task.sleep(for: .seconds(wait))
          self.waiting = false
          due()
        }
      }
      return blocks
    }
  }
}

/// Same footprint as a chart, while its block streams in or its values load.
private struct ChartPlaceholder: View {
  var body: some View {
    RoundedRectangle(cornerRadius: 8).fill(.fill.tertiary).frame(height: ChartView.height)
  }
}

/// A chart whose values are in a file: the brain's thinned copy of them, or what it says is wrong with
/// the file in the chart's place.
private struct FileChart: View {
  let file: ChartFile
  @Environment(AppStore.self) private var store
  @State private var spec: ChartSpec?
  @State private var error: String?

  var body: some View {
    Group {
      if let spec {
        ChartView(spec: spec)
      } else if let error {
        Text(error).font(.footnote).foregroundStyle(.secondary)
      } else {
        ChartPlaceholder()
      }
    }
    .task(id: file) {
      do {
        let loaded = try await file.load(store.api)
        spec = loaded
        error = loaded == nil ? Self.failed : nil
      } catch let e as APIError where e.status != 0 {
        spec = nil
        error = e.message
      } catch {
        // Scrolled away while loading: it tries again when it's back.
        guard !Task.isCancelled else { return }
        spec = nil
        self.error = Self.failed
      }
    }
  }

  private static let failed = "The chart's data didn't load."
}

/// A code block, with Copy in its corner.
private struct CodeBlock: View {
  let code: String
  @State private var copied = false

  var body: some View {
    ScrollView(.horizontal) {
      Text(code)
        .font(.system(.footnote, design: .monospaced))
        .padding(10)
        .padding(.trailing, 24)
    }
    .background(.fill.tertiary, in: .rect(cornerRadius: 8))
    .overlay(alignment: .topTrailing) {
      Button {
        UIPasteboard.general.string = code
        copied = true
        Task {
          try? await Task.sleep(for: .seconds(1.5))
          copied = false
        }
      } label: {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .font(.caption)
          .frame(width: 30, height: 30)
          .contentShape(.rect)
      }
      .buttonStyle(.borderless)
      .foregroundStyle(.secondary)
      .accessibilityLabel("Copy code")
    }
  }
}
