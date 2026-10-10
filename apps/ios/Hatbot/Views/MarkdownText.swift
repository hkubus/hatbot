// Renders Hatbot's Markdown: blocks from Markdown.parse, inline formatting and links through
// AttributedString. Raw HTML is shown as text, never rendered.
import SwiftUI

struct MarkdownText: View {
  let text: String

  var body: some View {
    let blocks = Markdown.parse(text)
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
      ScrollView(.horizontal) {
        Text(code)
          .font(.system(.footnote, design: .monospaced))
          .padding(10)
      }
      .background(.fill.tertiary, in: .rect(cornerRadius: 8))
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
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }
}
