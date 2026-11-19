// Raw HTML is shown as text, never rendered.
import SwiftUI
import UIKit

struct MarkdownText: View {
  let text: String
  /// A reply still coming in: parsed again at most every 100 ms, not on every delta, and only from its
  /// last finished block.
  var streaming = false
  @State private var throttle = Throttle()
  @State private var due = 0
  @ScaledMetric(relativeTo: .body) private var mathScale: CGFloat = 1

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
      rich(text)
        .font(level == 1 ? .sans(.title3, .bold) : level == 2 ? .sans(.headline, .semibold) : .sans(.subheadline, .bold))
    case let .paragraph(text):
      rich(text)
    case let .list(items):
      VStack(alignment: .leading, spacing: 3) {
        ForEach(items.indices, id: \.self) { i in
          let item = items[i]
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(item.marker).monospacedDigit().foregroundStyle(.secondary)
            rich(item.text)
          }
          .padding(.leading, CGFloat(item.depth) * 16)
        }
      }
    case let .quote(text):
      HStack(spacing: 10) {
        RoundedRectangle(cornerRadius: 1.5).fill(.tertiary).frame(width: 3)
        rich(text).foregroundStyle(.secondary)
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
          GridRow { ForEach(header.indices, id: \.self) { rich(header[$0]).bold() } }
          Divider()
          ForEach(rows.indices, id: \.self) { r in
            GridRow { ForEach(rows[r].indices, id: \.self) { rich(rows[r][$0]) } }
          }
        }
        .font(.sans(.subheadline))
      }
    case .rule:
      Divider()
    case let .math(tex):
      MathBlock(tex: tex)
    }
  }

  /// Where a line's maths goes while the rest of it is parsed, so **bold** around it holds.
  private static let slot: Character = "\u{E000}"

  /// The line's Markdown, with its maths drawn on the text's baseline.
  private func rich(_ text: String) -> Text {
    let runs = Markdown.mathRuns(text)
    guard runs.contains(where: \.isMath) else { return Text(inline(text)) }
    var tex: [String] = []
    var source = ""
    for run in runs {
      switch run {
      case let .text(t): source += t
      case let .math(t):
        tex.append(t)
        source.append(Self.slot)
      }
    }
    let parsed = inline(source)
    var line = Text(verbatim: "")
    var rest = parsed[parsed.startIndex...]
    for t in tex {
      guard let at = rest.characters.firstIndex(of: Self.slot) else { break }
      line = Text("\(line)\(Text(AttributedString(rest[..<at])))\(math(t))")
      rest = rest[rest.characters.index(after: at)...]
    }
    return Text("\(line)\(Text(AttributedString(rest)))")
  }

  private func math(_ tex: String) -> Text {
    guard let drawn = TeX.draw(tex, size: TeX.size(mathScale), display: false) else {
      return Text(verbatim: tex).font(.code(.body))
    }
    return Text(Image(uiImage: drawn.image).renderingMode(.template)).baselineOffset(-drawn.descent)
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

  /// Parsed at most every 100 ms; `due` is bumped when the wait is over so the latest text gets parsed.
  @MainActor
  private final class Throttle {
    private var parsed: String?
    private var parser = StreamingMarkdown()
    private var blocks: [MDBlock] = []
    private var last = Date.distantPast
    private var waiting = false

    func blocks(_ text: String, due: @escaping @MainActor () -> Void) -> [MDBlock] {
      if text == parsed { return blocks }
      let wait = 0.1 - Date().timeIntervalSince(last)
      if wait <= 0 || parsed == nil {
        parsed = text
        blocks = parser.parse(text)
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
        Text(error).font(.sans(.footnote)).foregroundStyle(.secondary)
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

private struct CodeBlock: View {
  let code: String
  @State private var copied = false

  var body: some View {
    ScrollView(.horizontal) {
      Text(code)
        .font(.code(.footnote))
        .padding(10)
        .padding(.trailing, 24)
    }
    .background(Color.surface2, in: .rect(cornerRadius: 12))
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
