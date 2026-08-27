use latentmail_lib::os::deeplink::{parse, Mailto};

#[test]
fn mailto_parsing_prefills_every_composer_field() {
    assert_eq!(
        parse(
            "mailto:one%40example.com,two%40example.com?to=three%40example.com&cc=cc%40example.com&bcc=bcc%40example.com&subject=Hello%20there&body=Line%201%0ALine%202",
        ),
        Some(Mailto {
            to: vec![
                "one@example.com".to_owned(),
                "two@example.com".to_owned(),
                "three@example.com".to_owned(),
            ],
            cc: vec!["cc@example.com".to_owned()],
            bcc: vec!["bcc@example.com".to_owned()],
            subject: "Hello there".to_owned(),
            body: "Line 1\nLine 2".to_owned(),
        })
    );
}

#[test]
fn mailto_parsing_rejects_invalid_and_non_mailto_values() {
    assert!(parse("https://example.com").is_none());
    assert!(parse("mailto://example.com").is_none());
    assert!(parse("mailto:bad%").is_none());
}
