//! Answers "does this domain publish a brand logo, and where" — candidate
//! ordering, TXT parsing, and the per-candidate download/validate sequence.
//! Every failure at every step is silent and simply advances to the next
//! candidate (or, having exhausted them, yields no logo); nothing here ever
//! returns an error a caller needs to surface.

use super::{
    cache::{hash_key, AvatarCache, CacheAnswer, CacheDomain},
    image, resolver,
};

/// Builds the ordered candidate list from `domain` up to and including its
/// registrable domain (D6), via the compiled-in Public Suffix List — so
/// `news.corp.aviva.co.uk` yields `news.corp.aviva.co.uk`,
/// `corp.aviva.co.uk`, `aviva.co.uk`, and never `co.uk` itself.
pub fn candidate_domains(domain: &str) -> Vec<String> {
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() {
        return Vec::new();
    }
    // `psl::domain_str` returns `None` when `domain` itself is a public
    // suffix (or otherwise has no registrable domain under it) — there is
    // nothing safe to query in that case, since every candidate would be a
    // suffix query (D6).
    let Some(registrable) = psl::domain_str(&domain).map(str::to_ascii_lowercase) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    let mut current = domain.as_str();
    loop {
        candidates.push(current.to_owned());
        if current == registrable {
            break;
        }
        match current.split_once('.') {
            Some((_, rest)) if rest.len() >= registrable.len() => current = rest,
            _ => break,
        }
    }
    candidates
}

/// Parses one TXT record's value for its `l=` logo URL, tolerating
/// surrounding quotes (the record content this receives has already been
/// re-joined across multiple TXT character-strings by
/// [`resolver::lookup_txt`]). Returns `None` when `l=` is absent or its
/// value is not an absolute `https` URL — BIMI logos are `https`-only.
pub fn parse_logo_url(txt_value: &str) -> Option<String> {
    for tag in txt_value.split(';') {
        let Some(value) = tag.trim().strip_prefix("l=") else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim();
        return value.starts_with("https://").then(|| value.to_owned());
    }
    None
}

/// Runs the full BIMI resolution sequence for `sender_domain`: walk
/// candidates from full domain to registrable domain, and for each,
/// **consult `cache` first** (a fresh positive or negative answer for that
/// specific candidate short-circuits the rest of its work) before looking up
/// its `default._bimi.` TXT record, downloading the advertised asset, and
/// validating + normalizing it. Every outcome — hit or miss — is written
/// back to `cache` keyed by the candidate domain that produced it, not just
/// `sender_domain` itself, so a sibling subdomain sharing a parent candidate
/// (e.g. `news.corp.aviva.co.uk` and `mail.corp.aviva.co.uk` sharing
/// `aviva.co.uk`) reuses that parent's cached answer instead of re-querying
/// it. Returns the first candidate's validated PNG, or `None` once every
/// candidate has been tried without success.
pub async fn resolve_logo(cache: &AvatarCache, sender_domain: &str) -> Option<Vec<u8>> {
    for candidate in candidate_domains(sender_domain) {
        let cache_key = hash_key(&candidate);
        match cache.answer(&cache_key, CacheDomain::Sender).await {
            CacheAnswer::Fresh(Some(path)) => {
                if let Ok(bytes) = std::fs::read(&path) {
                    return Some(bytes);
                }
                // The cached metadata row outlived the file on disk — fall
                // through like any other silent failure in this walk.
                continue;
            }
            // A fresh negative answer for this specific candidate — nothing
            // to download, move straight to the next candidate.
            CacheAnswer::Fresh(None) => continue,
            CacheAnswer::Stale => {}
        }

        let Some(url) = lookup_logo_url(&candidate).await else {
            let _ = cache.store_miss(&cache_key).await;
            continue;
        };
        let Some(bytes) = resolver::download(&url).await else {
            let _ = cache.store_miss(&cache_key).await;
            continue;
        };
        let Ok(validated) = image::validate(&bytes) else {
            let _ = cache.store_miss(&cache_key).await;
            continue;
        };
        let png = image::normalize_to_png(validated);
        let _ = cache.store_hit(&cache_key, CacheDomain::Sender, &png).await;
        return Some(png);
    }
    None
}

async fn lookup_logo_url(candidate: &str) -> Option<String> {
    let name = format!("default._bimi.{candidate}");
    resolver::lookup_txt(&name)
        .await
        .iter()
        .find_map(|record| parse_logo_url(record))
}

