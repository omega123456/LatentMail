use latentmail_lib::os::{
    deeplink,
    instance::{has_arguments, mailto_argument},
};

#[test]
fn identifies_a_second_launch_with_arguments() {
    assert!(!has_arguments(&["LatentMail".to_owned()]));
    assert!(has_arguments(&[
        "LatentMail".to_owned(),
        "mailto:a@example.com".to_owned()
    ]));
}

#[test]
fn extracts_and_parses_a_mailto_argument() {
    let args = [
        "LatentMail".to_owned(),
        "--flag".to_owned(),
        "mailto:to@example.com?cc=cc%40example.com&bcc=bcc%40example.com&subject=Hello&body=Line%201"
            .to_owned(),
    ];
    let value = mailto_argument(&args).unwrap();
    assert_eq!(
        deeplink::parse(value).unwrap(),
        deeplink::Mailto {
            to: vec!["to@example.com".to_owned()],
            cc: vec!["cc@example.com".to_owned()],
            bcc: vec!["bcc@example.com".to_owned()],
            subject: "Hello".to_owned(),
            body: "Line 1".to_owned(),
        }
    );
}

#[test]
fn rejects_non_mailto_urls() {
    assert!(deeplink::parse("https://example.com").is_none());
    assert!(mailto_argument(&["LatentMail".to_owned(), "--flag".to_owned()]).is_none());
}
