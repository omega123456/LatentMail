use image::ImageFormat;

pub fn rasterize_tiff(bytes: &[u8]) -> Result<Vec<u8>, image::ImageError> {
    let decoded = image::load_from_memory_with_format(bytes, ImageFormat::Tiff)?;
    let mut out = Vec::new();
    decoded.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)?;
    Ok(out)
}
