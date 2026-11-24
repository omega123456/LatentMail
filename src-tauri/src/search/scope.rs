use serde::Deserialize;

use crate::gmail::system_labels::{is_trash_or_spam, SPAM, TRASH};

pub const DEFAULT_EXCLUDED_LABELS: [&str; 3] = [TRASH, SPAM, "DRAFT"];

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchScope {
    Default,
    All,
    Label { label_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeFilter {
    pub excluded_labels: Vec<String>,
    pub required_label: Option<String>,
}

impl ScopeFilter {
    pub fn includes_trashed_and_spammed(&self) -> bool {
        match &self.required_label {
            Some(label) => is_trash_or_spam(label),
            None => !self
                .excluded_labels
                .iter()
                .any(|label| is_trash_or_spam(label)),
        }
    }
}

pub fn resolve(scope: &SearchScope) -> ScopeFilter {
    match scope {
        SearchScope::Default => ScopeFilter {
            excluded_labels: DEFAULT_EXCLUDED_LABELS
                .iter()
                .map(|label| (*label).to_owned())
                .collect(),
            required_label: None,
        },
        SearchScope::All => ScopeFilter {
            excluded_labels: Vec::new(),
            required_label: None,
        },
        SearchScope::Label { label_id } => ScopeFilter {
            excluded_labels: Vec::new(),
            required_label: Some(label_id.clone()),
        },
    }
}
