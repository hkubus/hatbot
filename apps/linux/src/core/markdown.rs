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
    /// Whether a table's head is behind the parser, and no row of it yet.
    table_started: bool,
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
                self.table_started = false;
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
                self.table_started = true;
            }
            TagEnd::TableRow => {
                if let Some((head, rows)) = self.table.as_mut() {
                    // A table needs its head: without one, the parser makes every row a head.
                    if !self.table_started {
                        *head = self.row.clone();
                        self.table_started = true;
                    }
                    rows.push(std::mem::take(&mut self.row));
                }
            }
            TagEnd::Table => {
                if let Some((head, rows)) = self.table.take() {
                    let rows = if !self.table_started || head.is_empty() && rows.is_empty() {
                        vec![]
                    } else {
                        rows
                    }
                    .into_iter()
                    .filter(|r| !r.is_empty())
                    .collect();
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

/// Where a text that may go on can be read to. A word still being typed where a block could start—a
/// heading ("# Note" is a paragraph until its line ends), an autolink ("https://…")—reads as that
/// until the line goes on, and it can still change what's there before it, so it's left for the next
/// redraw. A list's marker is complete with a space after it. None when there's no such word.
fn settled(text: &str) -> Option<usize> {
    if in_table(text) {
        return None;
    }
    let line = text.rsplit('\n').next().unwrap_or("");
    let starts_at = text.len() - line.len();
    let word = line
        .rfind(|c: char| c.is_whitespace())
        .map_or(0, |at| at + 1);
    // The spaces of an indented line aren't a word: nothing has been typed of one yet.
    let word = line[..word].trim().len();
    let only_spaces = word == 0 && line.trim().is_empty();
    let piece = &line[word..];
    if piece.is_empty() || only_spaces {
        return None;
    }
    let c = piece.chars().next()?;
    let heading = piece.len() <= 6 && piece.chars().all(|c| c == '#');
    let marker = piece.len() <= 3 && piece.chars().all(|c| matches!(c, '-' | '*' | '+'));
    let url = (piece.starts_with("http://") || piece.starts_with("https://"))
        && !piece.contains(['<', '>']);
    (heading || marker || url || c == '|').then_some(starts_at + word)
}

/// Whether the last line is a table's, the head's or a row's: a row still being typed is another row
/// once its line ends, which reads as one more row of the same.
fn in_table(text: &str) -> bool {
    let mut lines = text.lines().rev();
    let last = lines.next().unwrap_or("").trim_start();
    if !last.starts_with('|') {
        return false;
    }
    let head = lines.next().is_some_and(|l| {
        let t = l.trim();
        t.starts_with('|') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
    });
    let delimiter = last.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '));
    head || delimiter
}

fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// One event of a text being read, owning its strings so they outlive the parser that made them.
fn own(event: Event<'_>) -> Event<'static> {
    use pulldown_cmark::CowStr;
    match event {
        Event::Start(tag) => Event::Start(tag.into_static()),
        Event::End(tag) => Event::End(tag),
        Event::Text(t) => Event::Text(CowStr::from(t.into_string())),
        Event::Code(t) => Event::Code(CowStr::from(t.into_string())),
        Event::InlineMath(t) => Event::InlineMath(CowStr::from(t.into_string())),
        Event::DisplayMath(t) => Event::DisplayMath(CowStr::from(t.into_string())),
        Event::Html(t) => Event::Html(CowStr::from(t.into_string())),
        Event::InlineHtml(t) => Event::InlineHtml(CowStr::from(t.into_string())),
        Event::FootnoteReference(t) => Event::FootnoteReference(CowStr::from(t.into_string())),
        // The rest carry no text: their lifetimes are nothing to do with the parser's.
        Event::SoftBreak => Event::SoftBreak,
        Event::HardBreak => Event::HardBreak,
        Event::Rule => Event::Rule,
        Event::TaskListMarker(done) => Event::TaskListMarker(done),
    }
}

pub fn blocks(text: &str) -> Vec<Block> {
    let mut stream = Streaming::new();
    stream.add(text);
    stream.finish()
}

/// A reply read while it streams: each time its text has grown, only the part since the last time is
/// read by the parser, and a block settles once a later one starts. So a redraw costs what the delta
/// brought and the block it's in, not the whole of the reply.
///
/// A line that may still turn into something else (a heading being typed, a link written as its URL, a
/// table's row) waits for the next redraw. When typing turns one into what reading it again would say
/// only by reading again what's before it, everything from the block it's in is read again.
#[derive(Default)]
pub struct Streaming {
    text: String,
    /// The events of the text read, where each starts and ends in it, and the next to read.
    events: Vec<(usize, Event<'static>, usize)>,
    next: usize,
    /// Where the parser has been handed text up to, and from where the text from there reads as the
    /// whole of it does: a paragraph's own start, a heading's line.
    read: usize,
    from: usize,
    settled: Vec<Block>,
    open: Builder,
    /// Where the last paragraph read began in the text; a block that's its own begins with one.
    paragraph_from: usize,
    /// A link whose paragraph began after its block did: that block was read as the link's words.
    relink: Option<usize>,
}

/// Whether a block that starts at `start` is a new one: its paragraph begins where it does, not in the
/// one being read (a link, or an emphasis, continues that one).
fn began_here(start: usize, paragraph_from: usize, code: bool) -> bool {
    !code && start <= paragraph_from
}

impl Streaming {
    pub fn new() -> Streaming {
        Streaming::default()
    }

    /// The text as it is now.
    pub fn add(&mut self, text: &str) {
        if !text.starts_with(&self.text[..]) {
            self.text.clear();
            self.events.clear();
            self.next = 0;
            self.read = 0;
            self.from = 0;
            self.settled.clear();
            self.open = Builder::default();
            self.paragraph_from = 0;
            self.relink = None;
        }
        self.text = text.to_string();
        if let Some(at) = self.relink.take() {
            self.back_to(at);
        }
        let to = settled(&self.text).unwrap_or(self.text.len());
        let (from, to) = (self.from, to.max(self.from));
        if from < to {
            let made: Vec<_> = Parser::new_ext(&self.text[from..to], options())
                .into_offset_iter()
                .map(|(event, range)| (from + range.start, own(event), from + range.end))
                .collect();
            self.events.extend(made);
        }
        self.read = to;
        self.step();
    }

    /// Forgets what was laid out from the text at `at` on, which is to be read differently.
    fn back_to(&mut self, at: usize) {
        self.events.retain(|(start, _, _)| *start < at);
        self.next = self.next.min(self.events.len());
        self.open = Builder::default();
        while self.settled.len() > self.settled_at(at) {
            self.settled.pop();
        }
        self.read = at;
        self.paragraph_from = at;
        self.from = self.line_start(at);
    }

    /// Where the line the text at `at` is in begins: a line read from its start reads as it would whole.
    fn line_start(&self, at: usize) -> usize {
        self.text[..at].rfind('\n').map_or(0, |nl| nl + 1)
    }

    /// How many of the settled blocks were settled by the events before the text at `at`.
    fn settled_at(&self, at: usize) -> usize {
        let mut count = 0;
        let mut b = Builder::default();
        for (start, event, _) in self.events.iter().take_while(|(start, _, _)| *start < at) {
            let before = b.blocks.len();
            if let Event::Start(tag) = event {
                b.start(tag.clone());
            }
            if is_block_start(event) && b.blocks.len() > before {
                count += b.blocks.len() - before;
            }
            let _ = start;
        }
        count
    }

    /// Reads the events made since the last time, settling every block a start of one closes.
    fn step(&mut self) {
        let mut b = std::mem::take(&mut self.open);
        while self.next < self.events.len() {
            let (start, event, end) = &self.events[self.next];
            if *end > self.read {
                break;
            }
            self.next += 1;
            if let Event::End(TagEnd::CodeBlock) = event {
                b.closed = fence_closed(&self.text[*start..*end]);
            }
            let before = b.blocks.len();
            match event {
                Event::Start(tag) => {
                    if began_here(*start, self.paragraph_from, b.code.is_some()) {
                        self.paragraph_from = *start;
                    }
                    b.start(tag.clone());
                }
                Event::End(tag) => b.end(*tag),
                Event::Text(t) if b.code.is_some() => b.text.push_str(t),
                Event::Text(t) => b.text.push_str(&escape(t)),
                Event::Code(t) => b.text.push_str(&format!("<tt>{}</tt>", escape(t))),
                Event::InlineMath(t) | Event::DisplayMath(t) => b.text.push_str(&escape(t)),
                Event::Html(t) | Event::InlineHtml(t) => {
                    if b.code.is_some() {
                        b.text.push_str(t);
                    } else {
                        b.text.push_str(&escape(t));
                    }
                }
                Event::SoftBreak | Event::HardBreak => b.text.push('\n'),
                Event::Rule => {
                    b.flush();
                    b.blocks.push(Block::Rule);
                }
                Event::TaskListMarker(done) => {
                    if let Some((marker, _)) = b.item.as_mut() {
                        *marker = if *done { "☑" } else { "☐" }.to_string();
                    }
                }
                Event::FootnoteReference(t) => b.text.push_str(&escape(t)),
            }
            if is_block_start(event) && b.blocks.len() > before {
                // The block that just ended can't change now: only the parser's end of text closes it.
                self.settled.append(&mut b.blocks);
            }
            if self.relink.is_none()
                && matches!(event, Event::Start(Tag::Link { .. }))
                && *start > self.paragraph_from
            {
                // Its paragraph began before: it was laid out as the link's words, not as the link.
                self.relink = Some(self.paragraph_from);
            }
        }
        self.open = b;
    }

    /// The blocks now, the last one as far as it goes.
    pub fn finish(&mut self) -> Vec<Block> {
        self.step();
        let mut b = std::mem::take(&mut self.open);
        b.flush();
        let mut out = std::mem::take(&mut self.settled);
        out.append(&mut b.blocks);
        self.paragraph_from = self.read;
        out
    }
}

/// Whether an event ends the block before it for keeps: a paragraph, a heading, a quote, an item, a
/// code block or a table, at their start. A list's end doesn't: its item's text may go on.
fn is_block_start(event: &Event) -> bool {
    matches!(
        event,
        Event::Start(
            Tag::Paragraph
                | Tag::Heading { .. }
                | Tag::CodeBlock(_)
                | Tag::Table(_)
                | Tag::BlockQuote(_)
                | Tag::Item
        ) | Event::Rule
    )
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

    #[test]
    fn a_reply_that_changes_is_read_again_from_where_it_changed() {
        let mut stream = Streaming::new();
        stream.add("First paragraph.\n\nSecond");
        assert_eq!(
            stream.finish(),
            vec![
                Block::Paragraph("First paragraph.".into()),
                Block::Paragraph("Second".into())
            ]
        );
        // The same text with a word changed, and a shorter one: both read as they would whole.
        for changed in ["First, paragraph.\n\nSecond", "First."] {
            stream.add(changed);
            assert_eq!(stream.finish(), blocks(changed));
        }
    }
}
