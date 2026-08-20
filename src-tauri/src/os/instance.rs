pub fn has_arguments(args: &[String]) -> bool {
    args.len() > 1
}

pub fn mailto_argument(args: &[String]) -> Option<&str> {
    args.iter()
        .skip(1)
        .map(String::as_str)
        .find(|argument| argument.starts_with("mailto:"))
}
