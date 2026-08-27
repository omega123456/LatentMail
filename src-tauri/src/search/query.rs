use chrono::{DateTime, Duration as ChronoDuration, Months, NaiveDate, Utc};

pub const MAX_QUERY_LENGTH: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryError {
    TooLong,
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLong => write!(
                formatter,
                "search query exceeds {MAX_QUERY_LENGTH} characters"
            ),
        }
    }
}

impl std::error::Error for QueryError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PredicateKind {
    Label(String),
    Unread,
    Starred,
    HasAttachment,
    SentBefore(i64),
    SentAfter(i64),
    TextExcludes(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Predicate {
    pub kind: PredicateKind,
    pub negated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedQuery {
    pub match_expression: Option<String>,
    pub has_text_term: bool,
    pub from: Option<String>,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    pub predicates: Vec<Predicate>,
}

impl ParsedQuery {
    pub fn empty() -> Self {
        Self {
            match_expression: None,
            has_text_term: false,
            from: None,
            to: None,
            subject: None,
            includes: Vec::new(),
            excludes: Vec::new(),
            predicates: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.match_expression.is_none() && self.predicates.is_empty()
    }
}

struct RawToken {
    negated: bool,
    key: Option<String>,
    value: String,
}

fn tokenize(text: &str) -> Vec<RawToken> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    let mut tokens = Vec::new();
    while index < chars.len() {
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        let negated = chars[index] == '-';
        if negated {
            index += 1;
        }
        let start = index;
        while index < chars.len() && !chars[index].is_whitespace() && chars[index] != '"' {
            index += 1;
        }
        let prefix: String = chars[start..index].iter().collect();
        if index < chars.len() && chars[index] == '"' {
            index += 1;
            let value_start = index;
            while index < chars.len() && chars[index] != '"' {
                index += 1;
            }
            let value: String = chars[value_start..index].iter().collect();
            if index < chars.len() {
                index += 1;
            }
            if let Some(key) = prefix.strip_suffix(':') {
                tokens.push(RawToken {
                    negated,
                    key: Some(key.to_lowercase()),
                    value,
                });
            } else if prefix.is_empty() {
                tokens.push(RawToken {
                    negated,
                    key: None,
                    value,
                });
            } else {
                let raw: String = chars[start..index].iter().collect();
                tokens.push(RawToken {
                    negated,
                    key: None,
                    value: raw,
                });
            }
        } else if let Some(colon_position) = prefix.find(':') {
            let key = prefix[..colon_position].to_lowercase();
            let value = prefix[colon_position + 1..].to_owned();
            tokens.push(RawToken {
                negated,
                key: Some(key),
                value,
            });
        } else if !prefix.is_empty() {
            tokens.push(RawToken {
                negated,
                key: None,
                value: prefix,
            });
        }
    }
    tokens
}

pub(crate) fn fts_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn push_literal(
    includes: &mut Vec<String>,
    excludes: &mut Vec<String>,
    fts_positive: &mut Vec<String>,
    fts_negative: &mut Vec<String>,
    raw: String,
    negated: bool,
) {
    let clause = fts_quote(&raw);
    if negated {
        excludes.push(raw);
        fts_negative.push(clause);
    } else {
        includes.push(raw);
        fts_positive.push(clause);
    }
}

#[allow(clippy::too_many_arguments)]
fn bind_field(
    field: &mut Option<String>,
    includes: &mut Vec<String>,
    excludes: &mut Vec<String>,
    fts_positive: &mut Vec<String>,
    fts_negative: &mut Vec<String>,
    column: &str,
    value: String,
    negated: bool,
) {
    if value.trim().is_empty() {
        return;
    }
    let clause = format!("{column}:{}", fts_quote(&value));
    if negated {
        excludes.push(value);
        fts_negative.push(clause);
    } else if field.is_none() {
        *field = Some(value);
        fts_positive.push(clause);
    } else {
        includes.push(value);
        fts_positive.push(clause);
    }
}

fn parse_absolute_cutoff(value: &str) -> Option<i64> {
    let value = value.trim();
    let date = NaiveDate::parse_from_str(value, "%Y/%m/%d")
        .or_else(|_| NaiveDate::parse_from_str(value, "%Y-%m-%d"))
        .ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp())
}

fn parse_duration_cutoff(now: DateTime<Utc>, value: &str) -> Option<i64> {
    let value = value.trim();
    if value.len() < 2 {
        return None;
    }
    let split_at = value.len() - 1;
    let (number_part, unit_part) = value.split_at(split_at);
    let amount: i64 = number_part.parse().ok()?;
    if amount < 0 {
        return None;
    }
    let cutoff = match unit_part.to_lowercase().as_str() {
        "d" => now - ChronoDuration::days(amount),
        "m" => now.checked_sub_months(Months::new(u32::try_from(amount).ok()?))?,
        "y" => {
            let months = u32::try_from(amount).ok()?.checked_mul(12)?;
            now.checked_sub_months(Months::new(months))?
        }
        _ => return None,
    };
    Some(cutoff.timestamp())
}

fn build(tokens: Vec<RawToken>, now: DateTime<Utc>) -> ParsedQuery {
    let mut from: Option<String> = None;
    let mut to: Option<String> = None;
    let mut subject: Option<String> = None;
    let mut includes: Vec<String> = Vec::new();
    let mut excludes: Vec<String> = Vec::new();
    let mut predicates: Vec<Predicate> = Vec::new();
    let mut fts_positive: Vec<String> = Vec::new();
    let mut fts_negative: Vec<String> = Vec::new();

    for token in tokens {
        let RawToken {
            negated,
            key,
            value,
        } = token;
        match key.as_deref() {
            None => {
                if value.trim().is_empty() {
                    continue;
                }
                push_literal(
                    &mut includes,
                    &mut excludes,
                    &mut fts_positive,
                    &mut fts_negative,
                    value,
                    negated,
                );
            }
            Some("from") => bind_field(
                &mut from,
                &mut includes,
                &mut excludes,
                &mut fts_positive,
                &mut fts_negative,
                "sender",
                value,
                negated,
            ),
            Some("to") => bind_field(
                &mut to,
                &mut includes,
                &mut excludes,
                &mut fts_positive,
                &mut fts_negative,
                "recipients",
                value,
                negated,
            ),
            Some("subject") => bind_field(
                &mut subject,
                &mut includes,
                &mut excludes,
                &mut fts_positive,
                &mut fts_negative,
                "subject",
                value,
                negated,
            ),
            Some("label") | Some("in") => {
                if !value.trim().is_empty() {
                    predicates.push(Predicate {
                        kind: PredicateKind::Label(value),
                        negated,
                    });
                }
            }
            Some("is") => match value.to_lowercase().as_str() {
                "unread" => predicates.push(Predicate {
                    kind: PredicateKind::Unread,
                    negated,
                }),
                "read" => predicates.push(Predicate {
                    kind: PredicateKind::Unread,
                    negated: !negated,
                }),
                "starred" => predicates.push(Predicate {
                    kind: PredicateKind::Starred,
                    negated,
                }),
                "unstarred" => predicates.push(Predicate {
                    kind: PredicateKind::Starred,
                    negated: !negated,
                }),
                _ => push_literal(
                    &mut includes,
                    &mut excludes,
                    &mut fts_positive,
                    &mut fts_negative,
                    format!("is:{value}"),
                    negated,
                ),
            },
            Some("has") => match value.to_lowercase().as_str() {
                "attachment" => predicates.push(Predicate {
                    kind: PredicateKind::HasAttachment,
                    negated,
                }),
                _ => push_literal(
                    &mut includes,
                    &mut excludes,
                    &mut fts_positive,
                    &mut fts_negative,
                    format!("has:{value}"),
                    negated,
                ),
            },
            Some("before") => match parse_absolute_cutoff(&value) {
                Some(cutoff) => predicates.push(Predicate {
                    kind: PredicateKind::SentBefore(cutoff),
                    negated,
                }),
                None => push_literal(
                    &mut includes,
                    &mut excludes,
                    &mut fts_positive,
                    &mut fts_negative,
                    format!("before:{value}"),
                    negated,
                ),
            },
            Some("after") => match parse_absolute_cutoff(&value) {
                Some(cutoff) => predicates.push(Predicate {
                    kind: PredicateKind::SentAfter(cutoff),
                    negated,
                }),
                None => push_literal(
                    &mut includes,
                    &mut excludes,
                    &mut fts_positive,
                    &mut fts_negative,
                    format!("after:{value}"),
                    negated,
                ),
            },
            Some("newer_than") => match parse_duration_cutoff(now, &value) {
                Some(cutoff) => predicates.push(Predicate {
                    kind: PredicateKind::SentAfter(cutoff),
                    negated,
                }),
                None => push_literal(
                    &mut includes,
                    &mut excludes,
                    &mut fts_positive,
                    &mut fts_negative,
                    format!("newer_than:{value}"),
                    negated,
                ),
            },
            Some("older_than") => match parse_duration_cutoff(now, &value) {
                Some(cutoff) => predicates.push(Predicate {
                    kind: PredicateKind::SentBefore(cutoff),
                    negated,
                }),
                None => push_literal(
                    &mut includes,
                    &mut excludes,
                    &mut fts_positive,
                    &mut fts_negative,
                    format!("older_than:{value}"),
                    negated,
                ),
            },
            Some(unknown) => push_literal(
                &mut includes,
                &mut excludes,
                &mut fts_positive,
                &mut fts_negative,
                format!("{unknown}:{value}"),
                negated,
            ),
        }
    }

    let match_expression = if !fts_positive.is_empty() {
        let positive = fts_positive.join(" ");
        if fts_negative.is_empty() {
            Some(positive)
        } else {
            Some(format!("{positive} NOT ({})", fts_negative.join(" OR ")))
        }
    } else if !fts_negative.is_empty() {
        for clause in fts_negative {
            predicates.push(Predicate {
                kind: PredicateKind::TextExcludes(clause),
                negated: false,
            });
        }
        None
    } else {
        None
    };

    ParsedQuery {
        has_text_term: match_expression.is_some(),
        match_expression,
        from,
        to,
        subject,
        includes,
        excludes,
        predicates,
    }
}

pub fn parse(text: &str, now: DateTime<Utc>) -> Result<ParsedQuery, QueryError> {
    if text.chars().count() > MAX_QUERY_LENGTH {
        return Err(QueryError::TooLong);
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(ParsedQuery::empty());
    }
    Ok(build(tokenize(trimmed), now))
}
