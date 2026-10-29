use hatbot::core::jpeg;

#[test]
fn reads_a_frames_size_from_its_header() {
    // SOI, an APP0 segment, then a baseline frame header for 1440 × 900.
    let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00];
    b.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x05, 0xA0, 0x03]);
    assert_eq!(jpeg::size(&b), Some((1440, 900)));
}

#[test]
fn something_else_has_no_size() {
    assert_eq!(jpeg::size(b"\x89PNG\r\n"), None);
    assert_eq!(jpeg::size(&[0xFF, 0xD8, 0xFF]), None);
}
