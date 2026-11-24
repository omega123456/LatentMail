pub const TRASH: &str = "TRASH";
pub const SPAM: &str = "SPAM";

pub fn is_trash_or_spam(label: &str) -> bool {
    label == TRASH || label == SPAM
}
