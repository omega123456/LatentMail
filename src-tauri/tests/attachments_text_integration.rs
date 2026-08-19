use latentmail_lib::attachments::decode_text;

#[test]
fn valid_utf8_bytes_decode_unchanged() {
    let bytes = "café — hello".as_bytes();
    assert_eq!(decode_text(bytes), "café — hello");
}

#[test]
fn non_utf8_single_byte_text_falls_back_to_windows_1252_without_replacement_characters() {
    let mut bytes = b"cafe ".to_vec();
    bytes.push(0xe9);
    bytes.extend_from_slice(b" report");

    let decoded = decode_text(&bytes);

    assert!(
        !decoded.contains('\u{FFFD}'),
        "windows-1252 fallback must not leave replacement characters: {decoded:?}"
    );
    assert!(decoded.contains('é'));
}

#[test]
fn empty_bytes_decode_to_an_empty_string() {
    assert_eq!(decode_text(&[]), "");
}
