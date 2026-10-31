// A reply read as it streams in, against reading it whole: markdown::Streaming is what the chat lays
// out while a bot writes, and it must come out the same, block for block, every time.
use hatbot::core::markdown::{Streaming, blocks};

const REPLIES: &[&str] = &[
    "# T\n\nP one.\n\n- a\n- b\n\n1. one\n2. two\n\n```sh\necho hi\nexport X=1\n```\n\nhttps://example.com/x\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd.",
    "Notes\n\n> a quote that goes on\n> and on\n\n* item with **bold**\n  * nested\n\n## Heading two\n\nGo to <https://example.com/y> now.\n\nThe end.",
    "| Step | What |\n|---|---|\n| 1 | A |\n| 2 | B |\n\nDone.",
    "**Bold** and `code` and [a link](https://olx.pl/x) and a [second](https://a.b) one.\n\n* * *\n\nLast.",
];

#[test]
fn a_reply_read_as_it_streams_in_is_what_reading_it_whole_says_at_every_point() {
    for reply in REPLIES {
        let mut stream = Streaming::new();
        for at in 0..=reply.len() {
            if !reply.is_char_boundary(at) {
                continue;
            }
            stream.add(&reply[..at]);
            assert_eq!(
                stream.finish(),
                blocks(&reply[..at]),
                "at {at}: {:?}",
                &reply[..at]
            );
        }
    }
}
