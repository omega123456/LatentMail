use std::{
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use crate::{avatars::cache::hash_key, gmail::GmailClient};

pub const CACHE_CEILING_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedAttachment {
    pub cache_path: PathBuf,
    pub display_path: PathBuf,
    pub mime_type: String,
    pub filename: String,
    pub size: u64,
}

#[derive(Clone)]
pub struct AttachmentCache {
    root: PathBuf,
}

impl AttachmentCache {
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn message_dir(&self, account_id: &str, message_id: &str) -> PathBuf {
        self.root.join(account_id).join(message_id)
    }

    fn raw_path(&self, account_id: &str, message_id: &str, attachment_id: &str) -> PathBuf {
        self.message_dir(account_id, message_id)
            .join(hash_key(attachment_id))
    }

    fn raster_path(&self, account_id: &str, message_id: &str, attachment_id: &str) -> PathBuf {
        self.message_dir(account_id, message_id)
            .join(format!("{}.png", hash_key(attachment_id)))
    }

    fn is_tiff(mime_type: &str) -> bool {
        mime_type.eq_ignore_ascii_case("image/tiff")
    }

    pub fn write_bytes(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_id: &str,
        filename: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> io::Result<CachedAttachment> {
        let dir = self.message_dir(account_id, message_id);
        fs::create_dir_all(&dir)?;
        let raw = self.raw_path(account_id, message_id, attachment_id);
        fs::write(&raw, bytes)?;
        let display_path = if Self::is_tiff(mime_type) {
            let raster = self.raster_path(account_id, message_id, attachment_id);
            match super::thumbnail::rasterize_tiff(bytes) {
                Ok(png) => {
                    fs::write(&raster, &png)?;
                    raster
                }
                Err(_) => raw.clone(),
            }
        } else {
            raw.clone()
        };
        Ok(CachedAttachment {
            cache_path: raw,
            display_path,
            mime_type: mime_type.to_owned(),
            filename: filename.to_owned(),
            size: bytes.len() as u64,
        })
    }

    pub fn lookup(
        &self,
        account_id: &str,
        message_id: &str,
        attachment_id: &str,
        filename: &str,
        mime_type: &str,
    ) -> Option<CachedAttachment> {
        let raw = self.raw_path(account_id, message_id, attachment_id);
        let metadata = fs::metadata(&raw).ok()?;
        let _ = touch(&raw);
        let display_path = if Self::is_tiff(mime_type) {
            let raster = self.raster_path(account_id, message_id, attachment_id);
            if raster.exists() {
                let _ = touch(&raster);
                raster
            } else {
                raw.clone()
            }
        } else {
            raw.clone()
        };
        Some(CachedAttachment {
            cache_path: raw,
            display_path,
            mime_type: mime_type.to_owned(),
            filename: filename.to_owned(),
            size: metadata.len(),
        })
    }

    pub async fn ensure(
        &self,
        client: &GmailClient,
        account_id: &str,
        message_id: &str,
        attachment_id: &str,
        filename: &str,
        mime_type: &str,
    ) -> Result<CachedAttachment, String> {
        let cache = self.clone();
        let account_id = account_id.to_owned();
        let message_id = message_id.to_owned();
        let attachment_id = attachment_id.to_owned();
        let filename = filename.to_owned();
        let mime_type = mime_type.to_owned();
        if let Some(cached) = tokio::task::spawn_blocking({
            let cache = cache.clone();
            let account_id = account_id.clone();
            let message_id = message_id.clone();
            let attachment_id = attachment_id.clone();
            let filename = filename.clone();
            let mime_type = mime_type.clone();
            move || {
                cache.lookup(
                    &account_id,
                    &message_id,
                    &attachment_id,
                    &filename,
                    &mime_type,
                )
            }
        })
        .await
        .map_err(|error| error.to_string())?
        {
            return Ok(cached);
        }
        let bytes = client
            .attachment(&message_id, &attachment_id)
            .await
            .map_err(|error| error.to_string())?;
        tokio::task::spawn_blocking(move || {
            cache.write_bytes(
                &account_id,
                &message_id,
                &attachment_id,
                &filename,
                &mime_type,
                &bytes,
            )
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
    }

    pub fn sweep(&self, ceiling_bytes: u64) -> io::Result<()> {
        let mut entries = Vec::new();
        collect_files(&self.root, &mut entries)?;
        let mut total: u64 = entries.iter().map(|(_, size, _)| *size).sum();
        if total <= ceiling_bytes {
            return Ok(());
        }
        entries.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in entries {
            if total <= ceiling_bytes {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
        Ok(())
    }
}

fn touch(path: &Path) -> io::Result<()> {
    let file = fs::OpenOptions::new().write(true).open(path)?;
    file.set_modified(SystemTime::now())
}

fn collect_files(dir: &Path, out: &mut Vec<(PathBuf, u64, SystemTime)>) -> io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_files(&path, out)?;
        } else if file_type.is_file() {
            let metadata = entry.metadata()?;
            out.push((path, metadata.len(), metadata.modified()?));
        }
    }
    Ok(())
}
