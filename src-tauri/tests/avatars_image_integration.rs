use latentmail_lib::avatars::image::{
    normalize_to_png, validate, ValidatedImage, MAX_DOWNLOAD_BYTES, OUTPUT_SIZE,
};

fn valid_png_bytes() -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(16, 16, image::Rgba([200, 30, 30, 255]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

const VALID_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <rect width="64" height="64" fill="red"/>
</svg>"#;

#[test]
fn a_valid_png_validates_and_normalizes_to_the_stored_size() {
    let validated = validate(&valid_png_bytes()).expect("valid PNG must validate");
    assert!(matches!(validated, ValidatedImage::Png(_)));
    let normalized = normalize_to_png(validated);
    let decoded =
        image::load_from_memory_with_format(&normalized, image::ImageFormat::Png).unwrap();
    assert_eq!(decoded.width(), OUTPUT_SIZE);
    assert_eq!(decoded.height(), OUTPUT_SIZE);
}

#[test]
fn a_truncated_png_is_rejected_without_panicking() {
    let full = valid_png_bytes();
    let truncated = &full[..full.len() / 2];
    assert!(validate(truncated).is_err());
}

#[test]
fn arbitrary_non_image_bytes_are_rejected_without_panicking() {
    assert!(validate(b"this is not an image or an svg document").is_err());
}

#[test]
fn empty_bytes_are_rejected_without_panicking() {
    assert!(validate(&[]).is_err());
}

#[test]
fn bytes_exceeding_the_maximum_download_size_are_rejected() {
    let oversized = vec![0u8; MAX_DOWNLOAD_BYTES + 1];
    let error = validate(&oversized).unwrap_err();
    assert!(error.contains("maximum accepted size"));
}

#[test]
fn a_valid_svg_rasterizes_to_the_stored_output_size() {
    let validated = validate(VALID_SVG.as_bytes()).expect("valid SVG must validate");
    assert!(matches!(validated, ValidatedImage::Svg(_)));
    let png_bytes = normalize_to_png(validated);
    assert!(!png_bytes.starts_with(b"<svg"));
    let decoded = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png).unwrap();
    assert_eq!(decoded.width(), OUTPUT_SIZE);
    assert_eq!(decoded.height(), OUTPUT_SIZE);
}

#[test]
fn malformed_svg_is_rejected_without_panicking() {
    let malformed = r#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="#;
    assert!(validate(malformed.as_bytes()).is_err());
}

#[test]
fn an_oversized_svg_source_is_rejected() {
    let oversized = r#"<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000">
      <rect width="5000" height="5000" fill="black"/>
    </svg>"#;
    let error = validate(oversized.as_bytes()).unwrap_err();
    assert!(error.contains("maximum accepted dimension"));
}

#[test]
fn an_oversized_png_source_is_rejected() {
    let image = image::RgbaImage::from_pixel(4100, 1, image::Rgba([10, 10, 10, 255]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    let error = validate(&bytes).unwrap_err();
    assert!(error.contains("maximum accepted dimension"));
}
