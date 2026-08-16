//! Acquires an account's Google profile photograph — the second of the two
//! acquisition pipelines. The userinfo document itself (name + picture
//! claims) and scope-deficiency detection are `auth`'s concern
//! ([`crate::auth::UserInfo`], [`crate::auth::token_has_scope`]); this
//! module only turns an already-known remote photograph URL into a
//! validated, normalized PNG — the same download/validate/normalize shape
//! [`super::bimi`] uses for a logo, minus the DNS/candidate walk.

use super::{image, resolver};

/// Downloads and validates the account photograph at `avatar_url`. `None`
/// on any failure — a missing photo, an unreachable URL, or bytes that
/// don't validate all degrade identically to "no photograph" (D11's silent
/// degradation applies here too, not just to the missing-scope case).
pub async fn acquire_photo(avatar_url: &str) -> Option<Vec<u8>> {
    let bytes = resolver::download(avatar_url).await?;
    let validated = image::validate(&bytes).ok()?;
    Some(image::normalize_to_png(validated))
}
