// Markdown in blocks the chat lays out, with each block's text as Pango markup. An unclosed fence
// runs to the end, so a streaming code block shows as code; raw HTML stays text, as on iOS.
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph(String),
    Heading(u8, String),
    Code {
        lang: String,
        text: String,
        /// Its fence is closed: one still streaming in isn't.
        closed: bool,
    },
    Quote(String),
    Item {
        marker: String,
        depth: usize,
        text: String,
    },
    Table {
        head: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Rule,
}

/// Text made safe to put in Pango markup.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Only these open from a message (AppLink.opens on iOS).
pub fn opens(url: &str) -> bool {
    let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
    url.contains(':') && ["http", "https", "mailto", "hatbot"].contains(&scheme.as_str())
}

#[derive(Default)]
struct Builder {
    blocks: Vec<Block>,
    /// The markup of the block being read.
    text: String,
    /// Each open list's next number, or None for bullets.
    lists: Vec<Option<u64>>,
    item: Option<(String, usize)>,
    quote: usize,
    heading: Option<u8>,
    code: Option<String>,
    /// Whether the code block ending now had its closing fence.
    closed: bool,
    table: Option<(Vec<String>, Vec<Vec<String>>)>,
    row: Vec<String>,
    /// Whether each open link is an <a>, or a <span> for one that won't open.
    links: Vec<bool>,
}

impl Builder {
    /// What's been read so far goes in a block of its own.
    fn flush(&mut self) {
        let text = std::mem::take(&mut self.text);
        let text = text.trim_matches('\n').to_string();
        if let Some((marker, depth)) = self.item.take() {
            self.blocks.push(Block::Item {
                marker,
                depth,
                text,
            });
            return;
        }
        if text.is_empty() {
            return;
        }
        let block = match self.heading {
            Some(level) => Block::Heading(level, text),
            None if self.quote > 0 => Block::Quote(text),
            None => Block::Paragraph(text),
        };
        self.blocks.push(block);
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => {
                // A loose list item's second paragraph stays in the item.
                if self.item.is_some() && !self.text.is_empty() {
                    self.text.push_str("\n\n");
                }
            }
            Tag::Heading { level, .. } => {
                self.flush();
                self.heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                });
            }
            Tag::BlockQuote(_) => {
                self.flush();
                self.quote += 1;
            }
            Tag::CodeBlock(kind) => {
                self.flush();
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("").to_string()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                self.code = Some(lang);
            }
            Tag::List(first) => {
                // An item's own text comes before its sub-list.
                if self.item.is_some() {
                    self.flush();
                }
                self.lists.push(first);
            }
            Tag::Item => {
                self.flush();
                let depth = self.lists.len().saturating_sub(1);
                let marker = match self.lists.last_mut() {
                    Some(Some(n)) => {
                        *n += 1;
                        format!("{}.", *n - 1)
                    }
                    _ => "•".to_string(),
                };
                self.item = Some((marker, depth));
            }
            Tag::Table(_) => {
                self.flush();
                self.table = Some((Vec::new(), Vec::new()));
            }
            Tag::TableHead | Tag::TableRow => self.row.clear(),
            Tag::TableCell => self.text.clear(),
            Tag::Emphasis => self.text.push_str("<i>"),
            Tag::Strong => self.text.push_str("<b>"),
            Tag::Strikethrough => self.text.push_str("<s>"),
            Tag::Link { dest_url, .. } if opens(&dest_url) => {
                self.text
                    .push_str(&format!("<a href=\"{}\">", escape(&dest_url)));
                self.links.push(true);
            }
            // A link that wouldn't open, and a picture, are their text.
            Tag::Link { .. } | Tag::Image { .. } => {
                self.text.push_str("<span>");
                self.links.push(false);
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph if self.item.is_some() => {}
            TagEnd::Paragraph => self.flush(),
            TagEnd::Heading(_) => {
                self.flush();
                self.heading = None;
            }
            TagEnd::BlockQuote(_) => {
                self.flush();
                self.quote = self.quote.saturating_sub(1);
            }
            TagEnd::CodeBlock => {
                let lang = self.code.take().unwrap_or_default();
                let text = std::mem::take(&mut self.text);
                let text = text.strip_suffix('\n').unwrap_or(&text).to_string();
                self.blocks.push(Block::Code {
                    lang,
                    text,
                    closed: self.closed,
                });
            }
            TagEnd::List(_) => {
                self.lists.pop();
            }
            TagEnd::Item => {
                if self.item.is_some() {
                    self.flush();
                }
            }
            TagEnd::TableCell => {
                let cell = std::mem::take(&mut self.text);
                self.row.push(cell.trim().to_string());
            }
            TagEnd::TableHead => {
                if let Some((head, _)) = self.table.as_mut() {
                    *head = std::mem::take(&mut self.row);
                }
            }
            TagEnd::TableRow => {
                if let Some((_, rows)) = self.table.as_mut() {
                    rows.push(std::mem::take(&mut self.row));
                }
            }
            TagEnd::Table => {
                if let Some((head, rows)) = self.table.take() {
                    self.blocks.push(Block::Table { head, rows });
                }
            }
            TagEnd::Emphasis => self.text.push_str("</i>"),
            TagEnd::Strong => self.text.push_str("</b>"),
            TagEnd::Strikethrough => self.text.push_str("</s>"),
            TagEnd::Link | TagEnd::Image => {
                let a = self.links.pop().unwrap_or(false);
                self.text.push_str(if a { "</a>" } else { "</span>" });
            }
            _ => {}
        }
    }
}

/// Whether a code block's source ends in the fence it opened with; an indented one has none.
fn fence_closed(block: &str) -> bool {
    let open = block.trim_start();
    let Some(c) = open.chars().next().filter(|c| *c == '`' || *c == '~') else {
        return true;
    };
    let fence = open.chars().take_while(|x| *x == c).count();
    let mut lines = block.trim_end().lines();
    lines.next();
    lines.last().is_some_and(|l| {
        let l = l.trim();
        l.len() >= fence && l.chars().all(|x| x == c)
    })
}

/// The blocks of `text`.
pub fn blocks(text: &str) -> Vec<Block> {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut b = Builder::default();
    for (event, range) in Parser::new_ext(text, options).into_offset_iter() {
        if let Event::End(TagEnd::CodeBlock) = event {
            b.closed = fence_closed(&text[range]);
        }
        match event {
            Event::Start(tag) => b.start(tag),
            Event::End(tag) => b.end(tag),
            Event::Text(t) if b.code.is_some() => b.text.push_str(&t),
            Event::Text(t) => b.text.push_str(&escape(&t)),
            Event::Code(t) => b.text.push_str(&format!("<tt>{}</tt>", escape(&t))),
            Event::InlineMath(t) | Event::DisplayMath(t) => b.text.push_str(&escape(&t)),
            Event::Html(t) | Event::InlineHtml(t) => {
                if b.code.is_some() {
                    b.text.push_str(&t);
                } else {
                    b.text.push_str(&escape(&t));
                }
            }
            Event::SoftBreak | Event::HardBreak => b.text.push('\n'),
            Event::Rule => {
                b.flush();
                b.blocks.push(Block::Rule);
            }
            Event::TaskListMarker(done) => {
                if let Some((marker, _)) = b.item.as_mut() {
                    *marker = if done { "☑" } else { "☐" }.to_string();
                }
            }
            Event::FootnoteReference(t) => b.text.push_str(&escape(&t)),
        }
    }
    b.flush();
    b.blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_in_a_message_is_text_and_an_unclosed_fence_is_code() {
        let got = blocks("Run <b>this</b> & [that](javascript:alert(1)):\n\n```sh\nrm -rf <dir>");
        assert_eq!(
            got,
            vec![
                Block::Paragraph("Run &lt;b&gt;this&lt;/b&gt; &amp; <span>that</span>:".into()),
                Block::Code {
                    lang: "sh".into(),
                    text: "rm -rf <dir>".into(),
                    closed: false
                },
            ]
        );
    }
}
