use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::gmail::GmailClient;

use super::mime::Part;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagedPart {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub path: PathBuf,
    pub content_id: Option<String>,
    pub size: u64,
}

impl StagedPart {
    pub fn read(&self) -> std::io::Result<Part> {
        Ok(Part {
            filename: self.filename.clone(),
            mime_type: self.mime_type.clone(),
            bytes: fs::read(&self.path)?,
            content_id: self.content_id.clone(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub operation_id: String,
    pub parts: Vec<StagedPart>,
}

#[derive(Clone, Copy, Debug)]
pub struct OwnerScope<'a> {
    pub account_id: &'a str,
    pub owner: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct OwnerTransfer<'a> {
    pub account_id: &'a str,
    pub from: &'a str,
    pub to: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct GmailAttachmentSource<'a> {
    pub message_id: &'a str,
    pub attachment_id: &'a str,
}

#[derive(Clone, Debug)]
pub struct NewStagedPart {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub content_id: Option<String>,
}

pub struct StagePathRequest<'a> {
    pub scope: OwnerScope<'a>,
    pub source: &'a Path,
    pub id: &'a str,
    pub mime_type: String,
    pub content_id: Option<String>,
}

pub struct PartLookup<'a> {
    pub account_id: &'a str,
    pub owners: &'a [&'a str],
    pub id: &'a str,
    pub filename: String,
    pub mime_type: String,
    pub content_id: Option<String>,
}

pub struct StageAttachmentRequest<'a> {
    pub scope: OwnerScope<'a>,
    pub source: GmailAttachmentSource<'a>,
    pub descriptor: NewStagedPart,
}

pub struct StageBytesRequest<'a> {
    pub scope: OwnerScope<'a>,
    pub descriptor: &'a StagedPart,
    pub bytes: &'a [u8],
}

pub struct Staging {
    root: PathBuf,
}

impl Staging {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn owner_dir(&self, scope: OwnerScope<'_>) -> PathBuf {
        self.root
            .join("drafts")
            .join(scope.account_id)
            .join(scope.owner)
    }

    pub fn stage_path(&self, request: StagePathRequest<'_>) -> std::io::Result<StagedPart> {
        let dir = self.owner_dir(request.scope);
        fs::create_dir_all(&dir)?;
        let filename = request
            .source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .to_owned();
        let target = dir.join(request.id);
        fs::copy(request.source, &target)?;
        let size = fs::metadata(&target)?.len();
        Ok(StagedPart {
            id: request.id.to_owned(),
            filename: filename,
            mime_type: request.mime_type,
            path: target,
            content_id: request.content_id,
            size: size,
        })
    }

    pub fn part(&self, lookup: PartLookup<'_>) -> std::io::Result<StagedPart> {
        find_part_across_owners(self, lookup)
    }

    pub fn move_owner(&self, transfer: OwnerTransfer<'_>) -> std::io::Result<()> {
        if transfer.from == transfer.to {
            return Ok(());
        }
        let source = self.owner_dir(OwnerScope {
            account_id: transfer.account_id,
            owner: transfer.from,
        });
        if !source.exists() {
            return Ok(());
        }
        let destination = self.owner_dir(OwnerScope {
            account_id: transfer.account_id,
            owner: transfer.to,
        });
        fs::create_dir_all(&destination)?;
        for entry in fs::read_dir(&source)? {
            let entry = entry?;
            fs::rename(entry.path(), destination.join(entry.file_name()))?;
        }
        fs::remove_dir_all(source)
    }

    pub fn stage_bytes(&self, request: StageBytesRequest<'_>) -> std::io::Result<StagedPart> {
        let dir = self.owner_dir(request.scope);
        fs::create_dir_all(&dir)?;
        let path = dir.join(&request.descriptor.id);
        fs::write(&path, request.bytes)?;
        Ok(StagedPart {
            id: request.descriptor.id.clone(),
            filename: request.descriptor.filename.clone(),
            mime_type: request.descriptor.mime_type.clone(),
            path: path,
            content_id: request.descriptor.content_id.clone(),
            size: request.bytes.len() as u64,
        })
    }

    pub async fn stage_attachment(
        &self,
        client: &GmailClient,
        request: StageAttachmentRequest<'_>,
    ) -> Result<StagedPart, String> {
        let bytes = client
            .attachment(request.source.message_id, request.source.attachment_id)
            .await
            .map_err(|error| error.to_string())?;
        let descriptor = StagedPart {
            id: request.descriptor.id,
            filename: request.descriptor.filename,
            mime_type: request.descriptor.mime_type,
            path: PathBuf::new(),
            content_id: request.descriptor.content_id,
            size: 0,
        };
        self.stage_bytes(StageBytesRequest {
            scope: request.scope,
            descriptor: &descriptor,
            bytes: &bytes,
        })
        .map_err(|error| error.to_string())
    }

    pub fn remove_part(&self, scope: OwnerScope<'_>, id: &str) -> std::io::Result<()> {
        let path = self.owner_dir(scope).join(id);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    pub fn snapshot(
        &self,
        operation_id: &str,
        parts: &[StagedPart],
    ) -> std::io::Result<SnapshotManifest> {
        let directory = self.root.join("operations").join(operation_id);
        fs::create_dir_all(&directory)?;
        let mut snapshot = Vec::with_capacity(parts.len());
        for part in parts {
            let path = directory.join(&part.id);
            fs::copy(&part.path, &path)?;
            let mut copy = part.clone();
            copy.path = path;
            snapshot.push(copy);
        }
        let manifest = SnapshotManifest {
            operation_id: operation_id.to_owned(),
            parts: snapshot,
        };
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&manifest).expect("manifest serializes"),
        )?;
        Ok(manifest)
    }

    pub fn release_snapshot(&self, operation_id: &str) -> std::io::Result<()> {
        let path = self.root.join("operations").join(operation_id);
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
        Ok(())
    }

    pub fn snapshot_manifest(&self, operation_id: &str) -> std::io::Result<SnapshotManifest> {
        let path = self
            .root
            .join("operations")
            .join(operation_id)
            .join("manifest.json");
        serde_json::from_slice(&fs::read(path)?)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }

    pub fn cleanup_orphan_snapshots(
        &self,
        live_operation_ids: &HashSet<String>,
    ) -> std::io::Result<()> {
        let operations = self.root.join("operations");
        let Ok(entries) = fs::read_dir(&operations) else {
            return Ok(());
        };
        for entry in entries {
            remove_if_orphan_snapshot(entry?, live_operation_ids)?;
        }
        Ok(())
    }

    pub fn release_owner(&self, account_id: &str, owner: &str) -> std::io::Result<()> {
        let path = self.owner_dir(OwnerScope {
            account_id: account_id,
            owner: owner,
        });
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
        Ok(())
    }
}

fn find_part_across_owners(
    staging: &Staging,
    lookup: PartLookup<'_>,
) -> std::io::Result<StagedPart> {
    let mut first_error = None;
    for owner in lookup.owners {
        let path = staging
            .owner_dir(OwnerScope {
                account_id: lookup.account_id,
                owner: owner,
            })
            .join(lookup.id);
        match fs::metadata(&path) {
            Ok(metadata) => {
                return Ok(StagedPart {
                    id: lookup.id.to_owned(),
                    filename: lookup.filename,
                    mime_type: lookup.mime_type,
                    path: path,
                    content_id: lookup.content_id,
                    size: metadata.len(),
                });
            }
            Err(error) => first_error.get_or_insert(error),
        };
    }
    Err(first_error.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no candidate owner given")
    }))
}

fn remove_if_orphan_snapshot(
    entry: fs::DirEntry,
    live_operation_ids: &HashSet<String>,
) -> std::io::Result<()> {
    let is_orphan_dir = entry.file_type()?.is_dir()
        && !live_operation_ids.contains(&entry.file_name().to_string_lossy().into_owned());
    if is_orphan_dir {
        fs::remove_dir_all(entry.path())?;
    }
    Ok(())
}
