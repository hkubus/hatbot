// A reply streaming in, as the chat around it works: its text grows a few characters at a time, and a
// redraw reads it every 100 ms (chat.rs). Every redraw used to read the whole reply again as markdown;
// now only what came since the last one is read (markdown.rs's Streaming).
//   cargo bench --bench reply
use std::time::{Duration, Instant};

use hatbot::core::{delta, markdown};

/// How long a reply's measured time is, and how often its text is laid out again.
const SECONDS: u64 = 20;
const REDRAW: Duration = Duration::from_millis(100);
const CHUNK: &str = "The price is **1 199 zł** on OLX, and it `works`, [see](https://olx.pl/x). ";
const CODE: &str = "\n```sh\ncargo test\n";

/// The reply as the brain streams it: deltas of about this many characters.
const DELTA: usize = 4;
const REPLY: usize = 5_000;

fn reply(len: usize) -> String {
    let mut text = String::with_capacity(len + CODE.len() + 1);
    while text.len() < len {
        text.push_str(CHUNK);
    }
    text.push_str(CODE);
    text
}

fn main() {
    println!(
        "a reply of {REPLY} characters, {DELTA} at a time, read whole every {} ms",
        REDRAW.as_millis()
    );
    for chars in 1..=5 {
        let chars = chars * REPLY / 5;
        let full = reply(chars);
        let head: String = full.chars().take(DELTA).collect();

        // Adding: the last delta's characters onto the reply so far, the second that sent them. The
        // brain counts characters; these are letters, so `at` is where the character count says.
        let rounds = REPLY / DELTA;
        let started = Instant::now();
        let mut text = String::new();
        let mut counted = 0;
        for i in 0..rounds {
            let piece = &head[i % head.len()..];
            text = delta::added(piece, &text, Some(counted));
            counted += piece.chars().count();
        }
        let adding = started.elapsed();
        std::hint::black_box(&text);

        // Redrawing: the whole reply read again for each redraw in `SECONDS`.
        let redraws = SECONDS * 1_000 * (1_000 / REDRAW.as_millis() as u64) / 1_000;
        let started = Instant::now();
        for _ in 0..redraws {
            std::hint::black_box(markdown::blocks(&full));
        }
        let redrawing = started.elapsed().as_secs_f64() * 1_000.0;

        // Now: a reply that length arriving a few characters at a time, read as it comes.
        let mut stream = markdown::Streaming::new();
        let mut at = 0;
        let started = Instant::now();
        let step = REPLY / redraws as usize;
        for _ in 0..redraws {
            at = (at + step).min(full.len());
            let mut end = at;
            while !full.is_char_boundary(end) {
                end += 1;
            }
            stream.add(&full[..end]);
            std::hint::black_box(stream.finish());
        }
        let streaming = started.elapsed().as_secs_f64() * 1_000.0;

        // What's left of the overhead: a reader started for one delta, and a copy of the blocks it
        // hands over.
        let started = Instant::now();
        for _ in 0..redraws {
            let mut s = markdown::Streaming::new();
            s.add(&full[..DELTA]);
            std::hint::black_box(s.finish());
        }
        let fresh = started.elapsed().as_secs_f64() * 1_000.0;
        let blocks = markdown::blocks(&full);
        let started = Instant::now();
        for _ in 0..redraws {
            std::hint::black_box(blocks.clone());
        }
        let copying = started.elapsed().as_secs_f64() * 1_000.0;
        println!(
            "            streaming: a fresh reader {fresh:>7.2} ms, copying the blocks {copying:>7.2} ms"
        );

        // Adding, which a delta does as it arrives, beside the redraws.
        println!(
            "{chars:>6} chars: redraw whole {redrawing:>6.2} ms   streaming {streaming:>6.2} ms   ({redraws} redraws in {SECONDS} s, {adding:.2} ms for {rounds} deltas)",
            adding = adding.as_secs_f64() * 1_000.0,
        );
    }
}
