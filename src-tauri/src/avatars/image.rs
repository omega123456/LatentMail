//! Turns untrusted downloaded bytes into a trustworthy square PNG, or
//! refuses (D1). Format is detected from content, never from a declared
//! `Content-Type` header — the caller is expected to have already applied
//! [`MAX_DOWNLOAD_BYTES`] to whatever it downloaded.
//!
//! SVG input is rasterized here, in Rust, using `resvg`/`usvg` with system
//! font discovery never enabled (the `usvg::Options` default font database
//! is empty and `fontdb::Database::load_system_fonts` is never called) —
//! raw SVG markup never leaves this module, so it can never cross IPC or
//! reach the webview (D1, D15).

use image::{DynamicImage, ImageFormat};

/// The maximum accepted download size for a candidate asset (D15).
pub const MAX_DOWNLOAD_BYTES: usize = 512 * 1024;
/// The maximum accepted source image dimension, in either axis (D15). Bounds
/// the rasterization canvas so a pathological `viewBox` cannot be used as a
/// decompression bomb.
pub const MAX_SOURCE_DIMENSION: u32 = 4096;
/// The stored avatar raster's fixed size (D15).
pub const OUTPUT_SIZE: u32 = 128;

/// A downloaded asset that has passed content-based format validation and
/// dimension bounding, ready to be normalized into the stored raster.
#[derive(Debug)]
pub enum ValidatedImage {
    Png(Box<DynamicImage>),
    Svg(Box<usvg::Tree>),
}

/// Detects `bytes`' real format by decoding it, and rejects anything that
/// doesn't decode as a genuine PNG or parse as SVG, or that exceeds the
/// accepted size/dimension bounds. Never trusts a declared content type.
pub fn validate(bytes: &[u8]) -> Result<ValidatedImage, String> {
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err("downloaded asset exceeds the maximum accepted size".to_owned());
    }
    if bytes.is_empty() {
        return Err("downloaded asset is empty".to_owned());
    }
    if let Ok(ImageFormat::Png) = image::guess_format(bytes) {
        let decoded = image::load_from_memory_with_format(bytes, ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        if decoded.width() > MAX_SOURCE_DIMENSION || decoded.height() > MAX_SOURCE_DIMENSION {
            return Err("source PNG exceeds the maximum accepted dimension".to_owned());
        }
        return Ok(ValidatedImage::Png(Box::new(decoded)));
    }
    let options = usvg::Options::default();
    let tree = usvg::Tree::from_data(bytes, &options).map_err(|error| error.to_string())?;
    let size = tree.size();
    if size.width() > MAX_SOURCE_DIMENSION as f32 || size.height() > MAX_SOURCE_DIMENSION as f32 {
        return Err("source SVG exceeds the maximum accepted dimension".to_owned());
    }
    Ok(ValidatedImage::Svg(Box::new(tree)))
}

/// Normalizes any validated image into the stored `OUTPUT_SIZE` square PNG
/// — the one code path that ever produces the bytes written to the avatar
/// cache. SVG input is rasterized here; its raw markup never survives past
/// this call.
///
/// Infallible by construction: `OUTPUT_SIZE` is a fixed nonzero constant (so
/// canvas allocation can't fail) and encoding to an in-memory `Vec<u8>`
/// buffer never fails the way encoding to a real file/socket could — there
/// is no error a caller could meaningfully recover from, so this returns
/// bytes directly rather than threading a `Result` no branch can ever take.
pub fn normalize_to_png(image: ValidatedImage) -> Vec<u8> {
    match image {
        ValidatedImage::Png(decoded) => {
            let resized =
                decoded.resize_exact(OUTPUT_SIZE, OUTPUT_SIZE, image::imageops::FilterType::Lanczos3);
            let mut bytes = Vec::new();
            resized
                .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Png)
                .expect("encoding a decoded raster to an in-memory PNG buffer cannot fail");
            bytes
        }
        ValidatedImage::Svg(tree) => rasterize_svg(&tree),
    }
}

fn rasterize_svg(tree: &usvg::Tree) -> Vec<u8> {
    let mut pixmap = resvg::tiny_skia::Pixmap::new(OUTPUT_SIZE, OUTPUT_SIZE)
        .expect("OUTPUT_SIZE is a fixed nonzero constant, so canvas allocation cannot fail");
    let size = tree.size();
    let scale_x = OUTPUT_SIZE as f32 / size.width().max(1.0);
    let scale_y = OUTPUT_SIZE as f32 / size.height().max(1.0);
    resvg::render(
        tree,
        resvg::tiny_skia::Transform::from_scale(scale_x, scale_y),
        &mut pixmap.as_mut(),
    );
    pixmap
        .encode_png()
        .expect("encoding a freshly rendered pixmap to an in-memory PNG buffer cannot fail")
}
