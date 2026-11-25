use std::{
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use crate::{avatars::cache::hash_key, gmail::GmailClient};

pub const CACHE_CEILING_BYTES: u64 = 512 * 1024 * 1024;
const UNSAFE_PATH_CHARACTERS: [char; 4] = ['/', '\\', ':', '\0'];

#[derive(Clone, Copy, Debug)]
pub struct AttachmentRef<'a> {
    pub account_id: &'a str,
    pub message_id: &'a str,
    pub attachment_id: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct AttachmentDescriptor<'a> {
    pub target: AttachmentRef<'a>,
    pub filename: &'a str,
    pub mime_type: &'a str,
}

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

    fn message_dir(&self, account_id: &str, message_id: &str) -> io::Result<PathBuf> {
        let account_component = path_component(account_id)?;
        let message_component = path_component(message_id)?;
        Ok(self.root.join(account_component).join(message_component))
    }

    fn raw_path(&self, target: AttachmentRef<'_>) -> io::Result<PathBuf> {
        Ok(self
            .message_dir(target.account_id, target.message_id)?
            .join(hash_key(target.attachment_id)))
    }

    fn raster_path(&self, target: AttachmentRef<'_>) -> io::Result<PathBuf> {
        Ok(self
            .message_dir(target.account_id, target.message_id)?
            .join(format!("{}.png", hash_key(target.attachment_id))))
    }

    fn is_tiff(mime_type: &str) -> bool {
        mime_type.eq_ignore_ascii_case("image/tiff")
    }

    fn write_display_path(
        &self,
        descriptor: AttachmentDescriptor<'_>,
        bytes: &[u8],
    ) -> io::Result<PathBuf> {
        let raw = self.raw_path(descriptor.target)?;
        if !Self::is_tiff(descriptor.mime_type) {
            return Ok(raw);
        }
        let raster = self.raster_path(descriptor.target)?;
        let Ok(png) = super::thumbnail::rasterize_tiff(bytes) else {
            return Ok(raw);
        };
        fs::write(&raster, &png)?;
        Ok(raster)
    }

    fn lookup_display_path(
        &self,
        descriptor: AttachmentDescriptor<'_>,
        raw: &Path,
    ) -> Option<PathBuf> {
        if !Self::is_tiff(descriptor.mime_type) {
            return Some(raw.to_path_buf());
        }
        let raster = self.raster_path(descriptor.target).ok()?;
        if !raster.exists() {
            return Some(raw.to_path_buf());
        }
        let _ = touch(&raster);
        Some(raster)
    }

    pub fn write_bytes(
        &self,
        descriptor: AttachmentDescriptor<'_>,
        bytes: &[u8],
    ) -> io::Result<CachedAttachment> {
        let dir = self.message_dir(descriptor.target.account_id, descriptor.target.message_id)?;
        fs::create_dir_all(&dir)?;
        let raw = self.raw_path(descriptor.target)?;
        fs::write(&raw, bytes)?;
        let display_path = self.write_display_path(descriptor, bytes)?;
        Ok(CachedAttachment {
            cache_path: raw,
            display_path: display_path,
            mime_type: descriptor.mime_type.to_owned(),
            filename: descriptor.filename.to_owned(),
            size: bytes.len() as u64,
        })
    }

    pub fn lookup(&self, descriptor: AttachmentDescriptor<'_>) -> Option<CachedAttachment> {
        let raw = self.raw_path(descriptor.target).ok()?;
        let metadata = fs::metadata(&raw).ok()?;
        let _ = touch(&raw);
        let display_path = self.lookup_display_path(descriptor, &raw)?;
        Some(CachedAttachment {
            cache_path: raw,
            display_path: display_path,
            mime_type: descriptor.mime_type.to_owned(),
            filename: descriptor.filename.to_owned(),
            size: metadata.len(),
        })
    }

    pub async fn ensure(
        &self,
        client: &GmailClient,
        descriptor: AttachmentDescriptor<'_>,
    ) -> Result<CachedAttachment, String> {
        let owned = OwnedAttachmentDescriptor::from_ref(descriptor);
        if let Some(cached) = lookup_blocking(self.clone(), owned.clone()).await? {
            return Ok(cached);
        }
        let bytes = client
            .attachment(&owned.message_id, &owned.attachment_id)
            .await
            .map_err(|error| error.to_string())?;
        write_blocking(self.clone(), owned, bytes).await
    }

    pub fn sweep(&self, ceiling_bytes: u64) -> io::Result<()> {
        let mut entries = Vec::new();
        collect_files(&self.root, &mut entries)?;
        let total: u64 = entries.iter().map(|(_, size, _)| *size).sum();
        if total <= ceiling_bytes {
            return Ok(());
        }
        entries.sort_by_key(|(_, _, modified)| *modified);
        evict_oldest(entries, total, ceiling_bytes);
        Ok(())
    }
}

#[derive(Clone)]
struct OwnedAttachmentDescriptor {
    account_id: String,
    message_id: String,
    attachment_id: String,
    filename: String,
    mime_type: String,
}

impl OwnedAttachmentDescriptor {
    fn from_ref(descriptor: AttachmentDescriptor<'_>) -> Self {
        Self {
            account_id: descriptor.target.account_id.to_owned(),
            message_id: descriptor.target.message_id.to_owned(),
            attachment_id: descriptor.target.attachment_id.to_owned(),
            filename: descriptor.filename.to_owned(),
            mime_type: descriptor.mime_type.to_owned(),
        }
    }

    fn as_ref(&self) -> AttachmentDescriptor<'_> {
        AttachmentDescriptor {
            target: AttachmentRef {
                account_id: &self.account_id,
                message_id: &self.message_id,
                attachment_id: &self.attachment_id,
            },
            filename: &self.filename,
            mime_type: &self.mime_type,
        }
    }
}

async fn lookup_blocking(
    cache: AttachmentCache,
    descriptor: OwnedAttachmentDescriptor,
) -> Result<Option<CachedAttachment>, String> {
    tokio::task::spawn_blocking(move || cache.lookup(descriptor.as_ref()))
        .await
        .map_err(|error| error.to_string())
}

async fn write_blocking(
    cache: AttachmentCache,
    descriptor: OwnedAttachmentDescriptor,
    bytes: Vec<u8>,
) -> Result<CachedAttachment, String> {
    tokio::task::spawn_blocking(move || cache.write_bytes(descriptor.as_ref(), &bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn evict_oldest(entries: Vec<(PathBuf, u64, SystemTime)>, mut total: u64, ceiling_bytes: u64) {
    for (path, size, _) in entries {
        if total <= ceiling_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn path_component(identifier: &str) -> io::Result<&str> {
    if is_single_path_component(identifier) {
        return Ok(identifier);
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "identifier is not a single path component",
    ))
}

fn is_single_path_component(identifier: &str) -> bool {
    let is_relative_marker = identifier == "." || identifier == "..";
    let has_separator = identifier.contains(UNSAFE_PATH_CHARACTERS);
    !identifier.is_empty() && !is_relative_marker && !has_separator
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
            continue;
        }
        if file_type.is_file() {
            let metadata = entry.metadata()?;
            out.push((path, metadata.len(), metadata.modified()?));
        }
    }
    Ok(())
}
