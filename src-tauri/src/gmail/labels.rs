//! Label lifecycle Gmail calls, draft deletion (the documented exception to
//! the single coalescing mutation path — Gmail exposes no other way to
//! delete a draft), and the fixed colour palette with pre-flight rejection
//! of off-palette values (D10).
//!
//! Endpoint costs are declared in `gmail::mod` alongside every other
//! constant; this module only references them (Phase 3 constraint: a
//! single source of truth).

use serde::{Deserialize, Serialize};

use super::{
    GmailClient, GmailError, GmailLabel, LabelColorPair, DRAFTS_DELETE_COST, LABELS_CREATE_COST,
    LABELS_DELETE_COST, LABELS_UPDATE_COST,
};

/// Gmail's real, documented 102-pair label colour palette (24 base colours
/// plus 78 extended "more colours" swatches) — every id is a
/// human-readable, hue-accurate slug for its own hex pair (Slice audit
/// fix: several ids previously named the *wrong* hue entirely — e.g. an id
/// of `"orange"` pointed at a grey — and `"pink"` silently duplicated
/// `"red"`'s hex because the real grey `#434343` was dropped from the
/// list). Values are ordered to match `src/index.css`'s
/// `--color-label-gmail-{N}` custom properties one-for-one by position —
/// `src/lib/labels/palette.ts` mirrors this exact id/hex list so a picked
/// swatch id resolves to the same Gmail colour pair on both sides of IPC.
pub const LABEL_PALETTE: &[(&str, &str, &str)] = &[
    ("black", "#000000", "#ffffff"),
    ("charcoal", "#434343", "#ffffff"),
    ("slate-grey", "#666666", "#ffffff"),
    ("grey", "#999999", "#ffffff"),
    ("silver", "#cccccc", "#000000"),
    ("fog", "#efefef", "#000000"),
    ("mist", "#f3f3f3", "#000000"),
    ("white", "#ffffff", "#000000"),
    ("red", "#fb4c2f", "#ffffff"),
    ("orange", "#ffad47", "#000000"),
    ("amber", "#fad165", "#000000"),
    ("green", "#16a766", "#ffffff"),
    ("mint", "#43d692", "#000000"),
    ("blue", "#4a86e8", "#ffffff"),
    ("purple", "#a479e2", "#ffffff"),
    ("pink", "#f691b3", "#000000"),
    ("peach", "#f6c5be", "#000000"),
    ("cream", "#ffe6c7", "#000000"),
    ("butter", "#fef1d1", "#000000"),
    ("sage", "#b9e4d0", "#000000"),
    ("seafoam", "#c6f3de", "#000000"),
    ("sky", "#c9daf8", "#000000"),
    ("lavender", "#e4d7f5", "#000000"),
    ("blush", "#fcdee8", "#000000"),
    ("light-red", "#efa093", "#000000"),
    ("light-orange", "#ffd6a2", "#000000"),
    ("light-amber", "#fce8b3", "#000000"),
    ("emerald", "#89d3b2", "#000000"),
    ("light-emerald", "#a0eac9", "#000000"),
    ("light-blue", "#a4c2f4", "#000000"),
    ("light-violet", "#d0bcf1", "#000000"),
    ("pale-rose", "#fbc8d9", "#000000"),
    ("red-2", "#e66550", "#ffffff"),
    ("orange-2", "#ffbc6b", "#000000"),
    ("light-amber-2", "#fcda83", "#000000"),
    ("deep-emerald", "#44b984", "#ffffff"),
    ("emerald-2", "#68dfa9", "#000000"),
    ("blue-2", "#6d9eeb", "#ffffff"),
    ("violet", "#b694e8", "#000000"),
    ("light-rose", "#f7a7c0", "#000000"),
    ("deep-red", "#cc3a21", "#ffffff"),
    ("orange-3", "#eaa041", "#000000"),
    ("amber-2", "#f2c960", "#000000"),
    ("dark-emerald", "#149e60", "#ffffff"),
    ("deep-emerald-2", "#3dc789", "#ffffff"),
    ("deep-blue", "#3c78d8", "#ffffff"),
    ("violet-2", "#8e63ce", "#ffffff"),
    ("rose", "#e07798", "#ffffff"),
    ("deep-red-2", "#ac2b16", "#ffffff"),
    ("deep-orange", "#cf8933", "#ffffff"),
    ("amber-3", "#d5ae49", "#000000"),
    ("dark-emerald-2", "#0b804b", "#ffffff"),
    ("deep-emerald-3", "#2a9c68", "#ffffff"),
    ("deep-blue-2", "#285bac", "#ffffff"),
    ("deep-violet", "#653e9b", "#ffffff"),
    ("deep-rose", "#b65775", "#ffffff"),
    ("dark-red", "#822111", "#ffffff"),
    ("deep-orange-2", "#a46a21", "#ffffff"),
    ("deep-amber", "#aa8831", "#ffffff"),
    ("dark-emerald-3", "#076239", "#ffffff"),
    ("dark-emerald-4", "#1a764d", "#ffffff"),
    ("dark-blue", "#1c4587", "#ffffff"),
    ("dark-violet", "#41236d", "#ffffff"),
    ("deep-rose-2", "#83334c", "#ffffff"),
    ("graphite", "#464646", "#ffffff"),
    ("fog-2", "#e7e7e7", "#000000"),
    ("dark-blue-2", "#0d3472", "#ffffff"),
    ("light-blue-2", "#b6cff5", "#000000"),
    ("dark-cyan", "#0d3b44", "#ffffff"),
    ("cyan", "#98d7e4", "#000000"),
    ("dark-violet-2", "#3d188e", "#ffffff"),
    ("pale-violet", "#e3d7ff", "#000000"),
    ("dark-rose", "#711a36", "#ffffff"),
    ("pale-rose-2", "#fbd3e0", "#000000"),
    ("dark-red-2", "#8a1c0a", "#ffffff"),
    ("light-red-2", "#f2b2a8", "#000000"),
    ("dark-orange", "#7a2e0b", "#ffffff"),
    ("light-orange-2", "#ffc8af", "#000000"),
    ("dark-orange-2", "#7a4706", "#ffffff"),
    ("light-orange-3", "#ffdeb5", "#000000"),
    ("dark-gold", "#594c05", "#ffffff"),
    ("gold", "#fbe983", "#000000"),
    ("dark-amber", "#684e07", "#ffffff"),
    ("light-amber-3", "#fdedc1", "#000000"),
    ("dark-emerald-5", "#0b4f30", "#ffffff"),
    ("light-emerald-2", "#b3efd3", "#000000"),
    ("dark-emerald-6", "#04502e", "#ffffff"),
    ("emerald-3", "#a2dcc1", "#000000"),
    ("silver-2", "#c2c2c2", "#000000"),
    ("blue-3", "#4986e7", "#ffffff"),
    ("deep-cyan", "#2da2bb", "#ffffff"),
    ("light-violet-2", "#b99aff", "#000000"),
    ("deep-rose-3", "#994a64", "#ffffff"),
    ("light-rose-2", "#f691b2", "#000000"),
    ("orange-4", "#ff7537", "#ffffff"),
    ("orange-5", "#ffad46", "#000000"),
    ("dark-red-3", "#662e37", "#ffffff"),
    ("pale-red", "#ebdbde", "#000000"),
    ("red-3", "#cca6ac", "#000000"),
    ("dark-emerald-7", "#094228", "#ffffff"),
    ("deep-emerald-4", "#42d692", "#000000"),
    ("deep-emerald-5", "#16a765", "#ffffff"),
];

/// Resolves a design-token colour id to its Gmail wire colour pair, or
/// `None` for an id off the palette — the pre-flight rejection point every
/// label-colour-accepting command must call before touching the network.
pub fn resolve_color(id: &str) -> Option<LabelColorPair> {
    LABEL_PALETTE
        .iter()
        .find(|(entry_id, _, _)| *entry_id == id)
        .map(|(_, background, text)| LabelColorPair {
            text_color: (*text).to_owned(),
            background_color: (*background).to_owned(),
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LabelColorRequest<'a> {
    text_color: &'a str,
    background_color: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateLabelRequest<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<LabelColorRequest<'a>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLabel {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: Option<String>,
    messages_total: Option<i64>,
    messages_unread: Option<i64>,
    color: Option<RawColor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawColor {
    text_color: Option<String>,
    background_color: Option<String>,
}

fn map_label(raw: RawLabel) -> GmailLabel {
    GmailLabel {
        id: raw.id,
        name: raw.name,
        kind: raw.kind.unwrap_or_else(|| "user".into()).to_ascii_lowercase(),
        message_count: raw.messages_total.unwrap_or(0),
        unread_count: raw.messages_unread.unwrap_or(0),
        color: raw.color.and_then(|color| Some(LabelColorPair {
            text_color: color.text_color?,
            background_color: color.background_color?,
        })),
    }
}

impl GmailClient {
    pub async fn create_label(&self, name: &str, color: Option<&LabelColorPair>) -> Result<GmailLabel, GmailError> {
        let raw: RawLabel = self.send(
            reqwest::Method::POST,
            "/users/me/labels",
            &CreateLabelRequest { name, color: color.map(|value| LabelColorRequest { text_color: &value.text_color, background_color: &value.background_color }) },
            LABELS_CREATE_COST,
            false,
        ).await?;
        Ok(map_label(raw))
    }

    pub async fn update_label(&self, id: &str, name: Option<&str>, color: Option<&LabelColorPair>) -> Result<GmailLabel, GmailError> {
        let raw: RawLabel = self.send(
            reqwest::Method::PATCH,
            &format!("/users/me/labels/{id}"),
            &UpdateLabelRequest { name, color: color.map(|value| LabelColorRequest { text_color: &value.text_color, background_color: &value.background_color }) },
            LABELS_UPDATE_COST,
            false,
        ).await?;
        Ok(map_label(raw))
    }

    pub async fn delete_label(&self, id: &str) -> Result<(), GmailError> {
        let _: serde_json::Value = self.send(reqwest::Method::DELETE, &format!("/users/me/labels/{id}"), &(), LABELS_DELETE_COST, false).await?;
        Ok(())
    }

    pub async fn delete_draft(&self, id: &str) -> Result<(), GmailError> {
        let _: serde_json::Value = self.send(reqwest::Method::DELETE, &format!("/users/me/drafts/{id}"), &(), DRAFTS_DELETE_COST, false).await?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateLabelRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<LabelColorRequest<'a>>,
}
