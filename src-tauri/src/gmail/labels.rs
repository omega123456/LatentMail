use serde::{Deserialize, Serialize};

use super::{
    GmailClient, GmailError, GmailLabel, LabelColorPair, DRAFTS_DELETE_COST, LABELS_CREATE_COST,
    LABELS_DELETE_COST, LABELS_UPDATE_COST,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaletteEntry {
    pub id: &'static str,
    pub background: &'static str,
    pub text: &'static str,
}

const fn entry(id: &'static str, background: &'static str, text: &'static str) -> PaletteEntry {
    PaletteEntry {
        id: id,
        background: background,
        text: text,
    }
}

pub const LABEL_PALETTE: &[PaletteEntry] = &[
    entry("black", "#000000", "#ffffff"),
    entry("charcoal", "#434343", "#ffffff"),
    entry("slate-grey", "#666666", "#ffffff"),
    entry("grey", "#999999", "#ffffff"),
    entry("silver", "#cccccc", "#000000"),
    entry("fog", "#efefef", "#000000"),
    entry("mist", "#f3f3f3", "#000000"),
    entry("white", "#ffffff", "#000000"),
    entry("red", "#fb4c2f", "#ffffff"),
    entry("orange", "#ffad47", "#000000"),
    entry("amber", "#fad165", "#000000"),
    entry("green", "#16a766", "#ffffff"),
    entry("mint", "#43d692", "#000000"),
    entry("blue", "#4a86e8", "#ffffff"),
    entry("purple", "#a479e2", "#ffffff"),
    entry("pink", "#f691b3", "#000000"),
    entry("peach", "#f6c5be", "#000000"),
    entry("cream", "#ffe6c7", "#000000"),
    entry("butter", "#fef1d1", "#000000"),
    entry("sage", "#b9e4d0", "#000000"),
    entry("seafoam", "#c6f3de", "#000000"),
    entry("sky", "#c9daf8", "#000000"),
    entry("lavender", "#e4d7f5", "#000000"),
    entry("blush", "#fcdee8", "#000000"),
    entry("light-red", "#efa093", "#000000"),
    entry("light-orange", "#ffd6a2", "#000000"),
    entry("light-amber", "#fce8b3", "#000000"),
    entry("emerald", "#89d3b2", "#000000"),
    entry("light-emerald", "#a0eac9", "#000000"),
    entry("light-blue", "#a4c2f4", "#000000"),
    entry("light-violet", "#d0bcf1", "#000000"),
    entry("pale-rose", "#fbc8d9", "#000000"),
    entry("red-2", "#e66550", "#ffffff"),
    entry("orange-2", "#ffbc6b", "#000000"),
    entry("light-amber-2", "#fcda83", "#000000"),
    entry("deep-emerald", "#44b984", "#ffffff"),
    entry("emerald-2", "#68dfa9", "#000000"),
    entry("blue-2", "#6d9eeb", "#ffffff"),
    entry("violet", "#b694e8", "#000000"),
    entry("light-rose", "#f7a7c0", "#000000"),
    entry("deep-red", "#cc3a21", "#ffffff"),
    entry("orange-3", "#eaa041", "#000000"),
    entry("amber-2", "#f2c960", "#000000"),
    entry("dark-emerald", "#149e60", "#ffffff"),
    entry("deep-emerald-2", "#3dc789", "#ffffff"),
    entry("deep-blue", "#3c78d8", "#ffffff"),
    entry("violet-2", "#8e63ce", "#ffffff"),
    entry("rose", "#e07798", "#ffffff"),
    entry("deep-red-2", "#ac2b16", "#ffffff"),
    entry("deep-orange", "#cf8933", "#ffffff"),
    entry("amber-3", "#d5ae49", "#000000"),
    entry("dark-emerald-2", "#0b804b", "#ffffff"),
    entry("deep-emerald-3", "#2a9c68", "#ffffff"),
    entry("deep-blue-2", "#285bac", "#ffffff"),
    entry("deep-violet", "#653e9b", "#ffffff"),
    entry("deep-rose", "#b65775", "#ffffff"),
    entry("dark-red", "#822111", "#ffffff"),
    entry("deep-orange-2", "#a46a21", "#ffffff"),
    entry("deep-amber", "#aa8831", "#ffffff"),
    entry("dark-emerald-3", "#076239", "#ffffff"),
    entry("dark-emerald-4", "#1a764d", "#ffffff"),
    entry("dark-blue", "#1c4587", "#ffffff"),
    entry("dark-violet", "#41236d", "#ffffff"),
    entry("deep-rose-2", "#83334c", "#ffffff"),
    entry("graphite", "#464646", "#ffffff"),
    entry("fog-2", "#e7e7e7", "#000000"),
    entry("dark-blue-2", "#0d3472", "#ffffff"),
    entry("light-blue-2", "#b6cff5", "#000000"),
    entry("dark-cyan", "#0d3b44", "#ffffff"),
    entry("cyan", "#98d7e4", "#000000"),
    entry("dark-violet-2", "#3d188e", "#ffffff"),
    entry("pale-violet", "#e3d7ff", "#000000"),
    entry("dark-rose", "#711a36", "#ffffff"),
    entry("pale-rose-2", "#fbd3e0", "#000000"),
    entry("dark-red-2", "#8a1c0a", "#ffffff"),
    entry("light-red-2", "#f2b2a8", "#000000"),
    entry("dark-orange", "#7a2e0b", "#ffffff"),
    entry("light-orange-2", "#ffc8af", "#000000"),
    entry("dark-orange-2", "#7a4706", "#ffffff"),
    entry("light-orange-3", "#ffdeb5", "#000000"),
    entry("dark-gold", "#594c05", "#ffffff"),
    entry("gold", "#fbe983", "#000000"),
    entry("dark-amber", "#684e07", "#ffffff"),
    entry("light-amber-3", "#fdedc1", "#000000"),
    entry("dark-emerald-5", "#0b4f30", "#ffffff"),
    entry("light-emerald-2", "#b3efd3", "#000000"),
    entry("dark-emerald-6", "#04502e", "#ffffff"),
    entry("emerald-3", "#a2dcc1", "#000000"),
    entry("silver-2", "#c2c2c2", "#000000"),
    entry("blue-3", "#4986e7", "#ffffff"),
    entry("deep-cyan", "#2da2bb", "#ffffff"),
    entry("light-violet-2", "#b99aff", "#000000"),
    entry("deep-rose-3", "#994a64", "#ffffff"),
    entry("light-rose-2", "#f691b2", "#000000"),
    entry("orange-4", "#ff7537", "#ffffff"),
    entry("orange-5", "#ffad46", "#000000"),
    entry("dark-red-3", "#662e37", "#ffffff"),
    entry("pale-red", "#ebdbde", "#000000"),
    entry("red-3", "#cca6ac", "#000000"),
    entry("dark-emerald-7", "#094228", "#ffffff"),
    entry("deep-emerald-4", "#42d692", "#000000"),
    entry("deep-emerald-5", "#16a765", "#ffffff"),
];

pub fn resolve_color(id: &str) -> Option<LabelColorPair> {
    LABEL_PALETTE
        .iter()
        .find(|palette| palette.id == id)
        .map(|palette| LabelColorPair {
            text_color: palette.text.to_owned(),
            background_color: palette.background.to_owned(),
        })
}

pub struct LabelUpdate<'a> {
    pub name: Option<&'a str>,
    pub color: Option<&'a LabelColorPair>,
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
pub(super) struct RawLabel {
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

pub(super) fn map_label(raw: RawLabel) -> GmailLabel {
    GmailLabel {
        id: raw.id,
        name: raw.name,
        kind: raw
            .kind
            .unwrap_or_else(|| "user".into())
            .to_ascii_lowercase(),
        message_count: raw.messages_total.unwrap_or(0),
        unread_count: raw.messages_unread.unwrap_or(0),
        color: raw.color.and_then(|color| {
            Some(LabelColorPair {
                text_color: color.text_color?,
                background_color: color.background_color?,
            })
        }),
    }
}

impl GmailClient {
    pub async fn create_label(
        &self,
        name: &str,
        color: Option<&LabelColorPair>,
    ) -> Result<GmailLabel, GmailError> {
        let raw: RawLabel = self
            .send(super::SendRequest {
                method: reqwest::Method::POST,
                path: "/users/me/labels",
                body: &CreateLabelRequest {
                    name: name,
                    color: color.map(|value| LabelColorRequest {
                        text_color: &value.text_color,
                        background_color: &value.background_color,
                    }),
                },
                cost: LABELS_CREATE_COST,
                history: false,
            })
            .await?;
        Ok(map_label(raw))
    }

    pub async fn update_label(
        &self,
        id: &str,
        update: LabelUpdate<'_>,
    ) -> Result<GmailLabel, GmailError> {
        let path = format!("/users/me/labels/{id}");
        let raw: RawLabel = self
            .send(super::SendRequest {
                method: reqwest::Method::PATCH,
                path: &path,
                body: &UpdateLabelRequest {
                    name: update.name,
                    color: update.color.map(|value| LabelColorRequest {
                        text_color: &value.text_color,
                        background_color: &value.background_color,
                    }),
                },
                cost: LABELS_UPDATE_COST,
                history: false,
            })
            .await?;
        Ok(map_label(raw))
    }

    pub async fn delete_label(&self, id: &str) -> Result<(), GmailError> {
        let path = format!("/users/me/labels/{id}");
        let _: serde_json::Value = self
            .send(super::SendRequest {
                method: reqwest::Method::DELETE,
                path: &path,
                body: &(),
                cost: LABELS_DELETE_COST,
                history: false,
            })
            .await?;
        Ok(())
    }

    pub async fn delete_draft(&self, id: &str) -> Result<(), GmailError> {
        let path = format!("/users/me/drafts/{id}");
        let _: serde_json::Value = self
            .send(super::SendRequest {
                method: reqwest::Method::DELETE,
                path: &path,
                body: &(),
                cost: DRAFTS_DELETE_COST,
                history: false,
            })
            .await?;
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
