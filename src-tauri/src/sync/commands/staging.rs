use std::sync::Arc;

use serde::Deserialize;

use crate::compose::staging::{OwnerScope, StageBytesRequest, StagePathRequest};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFromPathRequest {
    pub account_id: String,
    pub owner: String,
    pub path: String,
    pub mime_type: String,
    pub content_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFromBytesRequest {
    pub account_id: String,
    pub owner: String,
    pub filename: String,
    pub mime_type: String,
    pub content_id: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStagedRequest {
    pub account_id: String,
    pub owner: String,
    pub id: String,
}

pub(super) fn run_stage_from_path(
    staging: &Arc<crate::compose::staging::Staging>,
    request: StageFromPathRequest,
) -> Result<crate::sync::dto::StagedAttachmentDto, String> {
    let id = crate::compose::drafts::generate_id("staged");
    let part = string_try!(staging.stage_path(StagePathRequest {
        scope: OwnerScope {
            account_id: &request.account_id,
            owner: &request.owner,
        },
        source: std::path::Path::new(&request.path),
        id: &id,
        mime_type: request.mime_type,
        content_id: request.content_id,
    }));
    Ok(part.into())
}

pub(super) fn run_stage_from_bytes(
    staging: &Arc<crate::compose::staging::Staging>,
    request: StageFromBytesRequest,
) -> Result<crate::sync::dto::StagedAttachmentDto, String> {
    let id = crate::compose::drafts::generate_id("staged");
    let descriptor = crate::compose::staging::StagedPart {
        id: id,
        filename: request.filename,
        mime_type: request.mime_type,
        path: std::path::PathBuf::new(),
        content_id: request.content_id,
        size: 0,
    };
    let part = string_try!(staging.stage_bytes(StageBytesRequest {
        scope: OwnerScope {
            account_id: &request.account_id,
            owner: &request.owner,
        },
        descriptor: &descriptor,
        bytes: &request.bytes,
    }));
    Ok(part.into())
}

pub(super) fn run_release_staged(
    staging: &Arc<crate::compose::staging::Staging>,
    request: ReleaseStagedRequest,
) -> Result<(), String> {
    string_try!(staging.remove_part(
        OwnerScope {
            account_id: &request.account_id,
            owner: &request.owner,
        },
        &request.id,
    ));
    Ok(())
}
