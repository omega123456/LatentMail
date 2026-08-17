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

pub async fn resolve_logo(cache: &AvatarCache, sender_domain: &str) -> Option<Vec<u8>> {
    for candidate in candidate_domains(sender_domain) {
        let cache_key = hash_key(&candidate);
        match cache.answer(&cache_key, CacheDomain::Sender).await {
            CacheAnswer::Fresh(Some(path)) => {
                if let Ok(bytes) = std::fs::read(&path) {
                    return Some(bytes);
                }
                continue;
            }
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

