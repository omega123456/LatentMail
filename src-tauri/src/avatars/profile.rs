use super::{image, resolver};

pub async fn acquire_photo(avatar_url: &str) -> Option<Vec<u8>> {
    let bytes = resolver::download(avatar_url).await?;
    let validated = image::validate(&bytes).ok()?;
    Some(image::normalize_to_png(validated))
}
