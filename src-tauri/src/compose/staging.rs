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
    /// Byte length of the staged file, read once via filesystem metadata at
    /// staging time so the chip UI never needs a second round trip (or
    /// client-side `File.size`, which a dropped/picked *path* never carries)
    /// just to render a size.
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

/// The Gmail message/attachment id pair identifying bytes to hydrate.
#[derive(Clone, Copy, Debug)]
pub struct GmailAttachmentSource<'a> {
    pub message_id: &'a str,
    pub attachment_id: &'a str,
}

/// The descriptor fields a caller supplies for a not-yet-staged part —
/// [`StagedPart`] minus its resolved `path`, which staging fills in.
#[derive(Clone, Debug)]
pub struct NewStagedPart {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub content_id: Option<String>,
}

pub struct Staging {
    root: PathBuf,
}
impl Staging {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    fn owner_dir(&self, account_id: &str, owner: &str) -> PathBuf {
        self.root.join("drafts").join(account_id).join(owner)
    }
    pub fn stage_path(
        &self,
        account_id: &str,
        owner: &str,
        source: &Path,
        id: &str,
        mime_type: String,
        content_id: Option<String>,
    ) -> std::io::Result<StagedPart> {
        let dir = self.owner_dir(account_id, owner);
        fs::create_dir_all(&dir)?;
        let filename = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment")
            .to_owned();
        let target = dir.join(id);
        fs::copy(source, &target)?;
        let size = fs::metadata(&target)?.len();
        Ok(StagedPart {
            id: id.to_owned(),
            filename,
            mime_type,
            path: target,
            content_id,
            size,
        })
    }
    /// Resolves one canonical part, trying each candidate owner in turn.
    /// A part's owner is not stable for the lifetime of a compose session:
    /// it is staged under whichever id the composer knew at the time, and
    /// ownership transfers to the stable Gmail draft id the moment the
    /// first create returns — so a save admitted anywhere around that
    /// transfer can legitimately name either id, and only the id that
    /// actually holds the bytes is authoritative.
    pub fn part(
        &self,
        account_id: &str,
        owners: &[&str],
        id: &str,
        filename: String,
        mime_type: String,
        content_id: Option<String>,
    ) -> std::io::Result<StagedPart> {
        let mut first_error = None;
        for owner in owners {
            let path = self.owner_dir(account_id, owner).join(id);
            match fs::metadata(&path) {
                Ok(metadata) => {
                    return Ok(StagedPart {
                        id: id.to_owned(),
                        filename,
                        mime_type,
                        path,
                        content_id,
                        size: metadata.len(),
                    })
                }
                Err(error) => first_error.get_or_insert(error),
            };
        }
        Err(first_error.unwrap_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no candidate owner given")
        }))
    }
    /// Transfers canonical parts to a new owner. Merges rather than renames
    /// the directory: the composer can have staged parts under *both* ids
    /// across the ownership transfer, and a plain rename onto a non-empty
    /// destination fails.
    pub fn move_owner(&self, account_id: &str, from: &str, to: &str) -> std::io::Result<()> {
        if from == to {
            return Ok(());
        }
        let source = self.owner_dir(account_id, from);
        if !source.exists() {
            return Ok(());
        }
        let destination = self.owner_dir(account_id, to);
        fs::create_dir_all(&destination)?;
        for entry in fs::read_dir(&source)? {
            let entry = entry?;
            fs::rename(entry.path(), destination.join(entry.file_name()))?;
        }
        fs::remove_dir_all(source)
    }
    pub fn stage_bytes(
        &self,
        account_id: &str,
        owner: &str,
        descriptor: &StagedPart,
        bytes: &[u8],
    ) -> std::io::Result<StagedPart> {
        let dir = self.owner_dir(account_id, owner);
        fs::create_dir_all(&dir)?;
        let path = dir.join(&descriptor.id);
        fs::write(&path, bytes)?;
        Ok(StagedPart {
            id: descriptor.id.clone(),
            filename: descriptor.filename.clone(),
            mime_type: descriptor.mime_type.clone(),
            path,
            content_id: descriptor.content_id.clone(),
            size: bytes.len() as u64,
        })
    }
    /// Hydrates a Gmail `attachmentId` into the same canonical staging tree
    /// picker/drop paths use, producing an identical [`StagedPart`]
    /// descriptor. This is the bridge acceptance criterion 8 requires:
    /// selected paths, inline data and Gmail-hydrated parts must be
    /// indistinguishable once staged.
    pub async fn stage_attachment(
        &self,
        client: &GmailClient,
        account_id: &str,
        owner: &str,
        source: GmailAttachmentSource<'_>,
        descriptor: NewStagedPart,
    ) -> Result<StagedPart, String> {
        let bytes = client
            .attachment(source.message_id, source.attachment_id)
            .await
            .map_err(|error| error.to_string())?;
        let descriptor = StagedPart {
            id: descriptor.id,
            filename: descriptor.filename,
            mime_type: descriptor.mime_type,
            // Unused by `stage_bytes` (which always writes under its own
            // canonical path and recomputes `size` from the real bytes) —
            // present only because `StagedPart` couples the descriptor and
            // its resolved location in one type.
            path: PathBuf::new(),
            content_id: descriptor.content_id,
            size: 0,
        };
        self.stage_bytes(account_id, owner, &descriptor, &bytes)
            .map_err(|error| error.to_string())
    }
    /// Removes one canonical staged part by id — the primitive behind
    /// explicit attachment removal (D3/D15); it never touches operation
    /// snapshots, which are independent and immutable once taken.
    pub fn remove_part(&self, account_id: &str, owner: &str, id: &str) -> std::io::Result<()> {
        let path = self.owner_dir(account_id, owner).join(id);
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
    /// Rehydrates the immutable payload recorded before queue admission.
    /// This intentionally reads only app-private staged files, never the
    /// user-selected source path that may be gone after a restart.
    pub fn snapshot_manifest(&self, operation_id: &str) -> std::io::Result<SnapshotManifest> {
        let path = self
            .root
            .join("operations")
            .join(operation_id)
            .join("manifest.json");
        serde_json::from_slice(&fs::read(path)?)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }
    /// Removes only completed/unreferenced operation snapshots. Canonical
    /// draft parts are in a separate tree and are never candidates here.
    pub fn cleanup_orphan_snapshots(
        &self,
        live_operation_ids: &HashSet<String>,
    ) -> std::io::Result<()> {
        let operations = self.root.join("operations");
        let Ok(entries) = fs::read_dir(&operations) else {
            return Ok(());
        };
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && !live_operation_ids.contains(&entry.file_name().to_string_lossy().into_owned())
            {
                fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }
    pub fn release_owner(&self, account_id: &str, owner: &str) -> std::io::Result<()> {
        let path = self.owner_dir(account_id, owner);
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
        Ok(())
    }
}
