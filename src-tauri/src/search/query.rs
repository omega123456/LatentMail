use chrono::{DateTime, Duration as ChronoDuration, Months, NaiveDate, Utc};

pub const MAX_QUERY_LENGTH: usize = 2048;
const MONTHS_PER_YEAR: u32 = 12;

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
        if let Some(token) = read_token(&chars, &mut index) {
            tokens.push(token);
        }
    }
    tokens
}

fn read_token(chars: &[char], index: &mut usize) -> Option<RawToken> {
    let negated = chars[*index] == '-';
    if negated {
        *index += 1;
    }
    let start = *index;
    while *index < chars.len() && !chars[*index].is_whitespace() && chars[*index] != '"' {
        *index += 1;
    }
    let prefix: String = chars[start..*index].iter().collect();
    let starts_quote = *index < chars.len() && chars[*index] == '"';
    if starts_quote {
        return Some(read_quoted_token(
            chars,
            index,
            QuotedTokenStart {
                start: start,
                prefix: prefix,
                negated: negated,
            },
        ));
    }
    if let Some(colon_position) = prefix.find(':') {
        return Some(RawToken {
            negated: negated,
            key: Some(prefix[..colon_position].to_lowercase()),
            value: prefix[colon_position + 1..].to_owned(),
        });
    }
    if prefix.is_empty() {
        return None;
    }
    Some(RawToken {
        negated: negated,
        key: None,
        value: prefix,
    })
}

struct QuotedTokenStart {
    start: usize,
    prefix: String,
    negated: bool,
}

fn read_quoted_token(chars: &[char], index: &mut usize, opening: QuotedTokenStart) -> RawToken {
    *index += 1;
    let value_start = *index;
    while *index < chars.len() && chars[*index] != '"' {
        *index += 1;
    }
    let value: String = chars[value_start..*index].iter().collect();
    if *index < chars.len() {
        *index += 1;
    }
    if let Some(key) = opening.prefix.strip_suffix(':') {
        return RawToken {
            negated: opening.negated,
            key: Some(key.to_lowercase()),
            value: value,
        };
    }
    if opening.prefix.is_empty() {
        return RawToken {
            negated: opening.negated,
            key: None,
            value: value,
        };
    }
    let raw: String = chars[opening.start..*index].iter().collect();
    RawToken {
        negated: opening.negated,
        key: None,
        value: raw,
    }
}

pub(crate) fn fts_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[derive(Default)]
struct TextTerms {
    includes: Vec<String>,
    excludes: Vec<String>,
    fts_positive: Vec<String>,
    fts_negative: Vec<String>,
}

struct FieldBinding {
    column: &'static str,
    value: String,
    negated: bool,
}

impl TextTerms {
    fn push_literal(&mut self, raw: String, negated: bool) {
        let clause = fts_quote(&raw);
        if negated {
            self.excludes.push(raw);
            self.fts_negative.push(clause);
            return;
        }
        self.includes.push(raw);
        self.fts_positive.push(clause);
    }

    fn bind_field(&mut self, field: &mut Option<String>, binding: FieldBinding) {
        if binding.value.trim().is_empty() {
            return;
        }
        let clause = format!("{}:{}", binding.column, fts_quote(&binding.value));
        if binding.negated {
            self.excludes.push(binding.value);
            self.fts_negative.push(clause);
            return;
        }
        if field.is_none() {
            *field = Some(binding.value);
            self.fts_positive.push(clause);
            return;
        }
        self.includes.push(binding.value);
        self.fts_positive.push(clause);
    }
}

fn parse_absolute_cutoff(value: &str) -> Option<i64> {
    let value = value.trim();
    let date = NaiveDate::parse_from_str(value, crate::date_formats::GMAIL_QUERY_DATE)
        .or_else(|_| NaiveDate::parse_from_str(value, crate::date_formats::ISO_DATE))
        .ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp())
}

fn parse_duration_cutoff(now: DateTime<Utc>, value: &str) -> Option<i64> {
    let value = value.trim();
    let (split_at, _) = value.char_indices().next_back()?;
    let (number_part, unit_part) = value.split_at(split_at);
    let amount: i64 = number_part.parse().ok()?;
    if amount < 0 {
        return None;
    }
    let cutoff = match unit_part.to_lowercase().as_str() {
        "d" => now - ChronoDuration::days(amount),
        "m" => now.checked_sub_months(Months::new(u32::try_from(amount).ok()?))?,
        "y" => {
            let months = u32::try_from(amount).ok()?.checked_mul(MONTHS_PER_YEAR)?;
            now.checked_sub_months(Months::new(months))?
        }
        _ => return None,
    };
    Some(cutoff.timestamp())
}

struct QueryAccumulator {
    now: DateTime<Utc>,
    from: Option<String>,
    to: Option<String>,
    subject: Option<String>,
    terms: TextTerms,
    predicates: Vec<Predicate>,
}

type TokenHandler = fn(&mut QueryAccumulator, String, bool);

const TOKEN_HANDLERS: &[(&str, TokenHandler)] = &[
    ("from", handle_from),
    ("to", handle_to),
    ("subject", handle_subject),
    ("label", handle_label),
    ("in", handle_label),
    ("is", handle_is),
    ("has", handle_has),
    ("before", handle_before),
    ("after", handle_after),
    ("newer_than", handle_newer_than),
    ("older_than", handle_older_than),
];

impl QueryAccumulator {
    fn new(now: DateTime<Utc>) -> Self {
        Self {
            now: now,
            from: None,
            to: None,
            subject: None,
            terms: TextTerms::default(),
            predicates: Vec::new(),
        }
    }

    fn push_non_empty_literal(&mut self, value: String, negated: bool) {
        if !value.trim().is_empty() {
            self.terms.push_literal(value, negated);
        }
    }

    fn apply_token(&mut self, token: RawToken) {
        let RawToken {
            negated,
            key,
            value,
        } = token;
        let Some(key) = key else {
            self.push_non_empty_literal(value, negated);
            return;
        };
        if let Some((_, handler)) = TOKEN_HANDLERS
            .iter()
            .find(|(candidate, _)| *candidate == key)
        {
            handler(self, value, negated);
            return;
        }
        self.terms.push_literal(format!("{key}:{value}"), negated);
    }

    fn push_predicate(&mut self, kind: PredicateKind, negated: bool) {
        self.predicates.push(Predicate {
            kind: kind,
            negated: negated,
        });
    }

    fn finish(mut self) -> ParsedQuery {
        let match_expression = finalize_match_expression(
            &self.terms.fts_positive,
            self.terms.fts_negative,
            &mut self.predicates,
        );
        ParsedQuery {
            has_text_term: match_expression.is_some(),
            match_expression: match_expression,
            from: self.from,
            to: self.to,
            subject: self.subject,
            includes: self.terms.includes,
            excludes: self.terms.excludes,
            predicates: self.predicates,
        }
    }
}

fn handle_from(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    accumulator.terms.bind_field(
        &mut accumulator.from,
        FieldBinding {
            column: "sender",
            value: value,
            negated: negated,
        },
    );
}

fn handle_to(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    accumulator.terms.bind_field(
        &mut accumulator.to,
        FieldBinding {
            column: "recipients",
            value: value,
            negated: negated,
        },
    );
}

fn handle_subject(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    accumulator.terms.bind_field(
        &mut accumulator.subject,
        FieldBinding {
            column: "subject",
            value: value,
            negated: negated,
        },
    );
}

fn handle_label(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    if value.trim().is_empty() {
        return;
    }
    accumulator.push_predicate(PredicateKind::Label(value), negated);
}

fn handle_is(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    match value.to_lowercase().as_str() {
        "unread" => accumulator.push_predicate(PredicateKind::Unread, negated),
        "read" => accumulator.push_predicate(PredicateKind::Unread, !negated),
        "starred" => accumulator.push_predicate(PredicateKind::Starred, negated),
        "unstarred" => accumulator.push_predicate(PredicateKind::Starred, !negated),
        _ => accumulator
            .terms
            .push_literal(format!("is:{value}"), negated),
    }
}

fn handle_has(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    if value.eq_ignore_ascii_case("attachment") {
        accumulator.push_predicate(PredicateKind::HasAttachment, negated);
        return;
    }
    accumulator
        .terms
        .push_literal(format!("has:{value}"), negated);
}

fn handle_before(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    let Some(cutoff) = parse_absolute_cutoff(&value) else {
        accumulator
            .terms
            .push_literal(format!("before:{value}"), negated);
        return;
    };
    accumulator.push_predicate(PredicateKind::SentBefore(cutoff), negated);
}

fn handle_after(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    let Some(cutoff) = parse_absolute_cutoff(&value) else {
        accumulator
            .terms
            .push_literal(format!("after:{value}"), negated);
        return;
    };
    accumulator.push_predicate(PredicateKind::SentAfter(cutoff), negated);
}

fn handle_newer_than(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    let Some(cutoff) = parse_duration_cutoff(accumulator.now, &value) else {
        accumulator
            .terms
            .push_literal(format!("newer_than:{value}"), negated);
        return;
    };
    accumulator.push_predicate(PredicateKind::SentAfter(cutoff), negated);
}

fn handle_older_than(accumulator: &mut QueryAccumulator, value: String, negated: bool) {
    let Some(cutoff) = parse_duration_cutoff(accumulator.now, &value) else {
        accumulator
            .terms
            .push_literal(format!("older_than:{value}"), negated);
        return;
    };
    accumulator.push_predicate(PredicateKind::SentBefore(cutoff), negated);
}

fn finalize_match_expression(
    fts_positive: &[String],
    fts_negative: Vec<String>,
    predicates: &mut Vec<Predicate>,
) -> Option<String> {
    if !fts_positive.is_empty() {
        let positive = fts_positive.join(" ");
        if fts_negative.is_empty() {
            return Some(positive);
        }
        return Some(format!("{positive} NOT ({})", fts_negative.join(" OR ")));
    }
    for clause in fts_negative {
        predicates.push(Predicate {
            kind: PredicateKind::TextExcludes(clause),
            negated: false,
        });
    }
    None
}

fn build(tokens: Vec<RawToken>, now: DateTime<Utc>) -> ParsedQuery {
    let mut accumulator = QueryAccumulator::new(now);
    for token in tokens {
        accumulator.apply_token(token);
    }
    accumulator.finish()
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
