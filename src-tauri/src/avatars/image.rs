use image::{DynamicImage, ImageFormat};

pub const MAX_DOWNLOAD_BYTES: usize = 512 * 1024;
pub const MAX_SOURCE_DIMENSION: u32 = 4096;
pub const OUTPUT_SIZE: u32 = 128;

#[derive(Debug)]
pub enum ValidatedImage {
    Png(Box<DynamicImage>),
    Svg(Box<usvg::Tree>),
}

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

pub fn normalize_to_png(image: ValidatedImage) -> Vec<u8> {
    match image {
        ValidatedImage::Png(decoded) => {
            let resized = decoded.resize_exact(
                OUTPUT_SIZE,
                OUTPUT_SIZE,
                image::imageops::FilterType::Lanczos3,
            );
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
