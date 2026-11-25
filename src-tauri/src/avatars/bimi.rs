use super::{
    cache::{hash_key, AvatarCache, CacheAnswer, CacheDomain},
    image, resolver,
};

pub fn candidate_domains(domain: &str) -> Vec<String> {
    let domain = domain.trim().to_ascii_lowercase();
    if domain.is_empty() {
        return Vec::new();
    }
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

async fn resolve_candidate_logo(cache: &AvatarCache, candidate: &str) -> Option<Vec<u8>> {
    let cache_key = hash_key(candidate);
    match cache.answer(&cache_key, CacheDomain::Sender).await {
        CacheAnswer::Fresh(Some(path)) => return std::fs::read(&path).ok(),
        CacheAnswer::Fresh(None) => return None,
        CacheAnswer::Stale => {}
    }
    let Some(url) = lookup_logo_url(candidate).await else {
        let _ = cache.store_miss(&cache_key).await;
        return None;
    };
    let Some(bytes) = resolver::download(&url).await else {
        let _ = cache.store_miss(&cache_key).await;
        return None;
    };
    let Ok(validated) = image::validate(&bytes) else {
        let _ = cache.store_miss(&cache_key).await;
        return None;
    };
    let png = image::normalize_to_png(validated);
    let _ = cache
        .store_hit(super::cache::CachedAvatar {
            cache_key: &cache_key,
            domain: CacheDomain::Sender,
            png_bytes: &png,
        })
        .await;
    Some(png)
}

pub async fn resolve_logo(cache: &AvatarCache, sender_domain: &str) -> Option<Vec<u8>> {
    for candidate in candidate_domains(sender_domain) {
        if let Some(logo) = resolve_candidate_logo(cache, &candidate).await {
            return Some(logo);
        }
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
