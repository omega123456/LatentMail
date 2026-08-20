#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DotColor {
    Unread,
    Reauthentication,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DotGeometry {
    pub radius: u32,
    pub center_x: u32,
    pub center_y: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RasterIcon {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

const TRAY_ICON: tauri::image::Image<'_> = tauri::include_image!("./icons/tray-icon.png");

pub fn dot_geometry(size: u32) -> DotGeometry {
    let radius = (size / 4).max(2);
    DotGeometry {
        radius,
        center_x: size.saturating_sub(radius + 1),
        center_y: radius + 1,
    }
}

pub fn dot_color(needs_reauthentication: bool) -> DotColor {
    if needs_reauthentication {
        DotColor::Reauthentication
    } else {
        DotColor::Unread
    }
}

pub fn dot_rgb(color: DotColor) -> [u8; 3] {
    match color {
        DotColor::Unread => [0, 120, 212],
        DotColor::Reauthentication => [211, 47, 47],
    }
}

pub fn tray_icon(unread_count: u64, needs_reauthentication: bool) -> Result<RasterIcon, String> {
    let base = image::RgbaImage::from_raw(
        TRAY_ICON.width(),
        TRAY_ICON.height(),
        TRAY_ICON.rgba().to_vec(),
    )
    .ok_or_else(|| "embedded tray icon has invalid dimensions".to_owned())?;
    let color = needs_reauthentication
        .then_some(DotColor::Reauthentication)
        .or_else(|| (unread_count > 0).then_some(DotColor::Unread));
    let geometry = dot_geometry(base.width());
    Ok(match color {
        Some(color) => dot_on(base, geometry, color),
        None => RasterIcon {
            width: base.width(),
            height: base.height(),
            rgba: base.into_raw(),
        },
    })
}

pub fn reauthentication_overlay() -> RasterIcon {
    let image = image::RgbaImage::new(16, 16);
    let geometry = DotGeometry {
        radius: 7,
        center_x: 8,
        center_y: 8,
    };
    dot_on(image, geometry, DotColor::Reauthentication)
}

fn dot_on(mut image: image::RgbaImage, geometry: DotGeometry, color: DotColor) -> RasterIcon {
    let [red, green, blue] = dot_rgb(color);
    let dot = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\"><circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"rgb({red},{green},{blue})\"/></svg>",
        image.width(), image.height(), geometry.center_x, geometry.center_y, geometry.radius
    );
    let tree =
        usvg::Tree::from_str(&dot, &usvg::Options::default()).expect("generated dot SVG is valid");
    let mut pixmap = resvg::tiny_skia::Pixmap::new(image.width(), image.height())
        .expect("icon dimensions are nonzero");
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );
    let rendered = image::load_from_memory_with_format(
        &pixmap.encode_png().expect("rendered pixmap encodes"),
        image::ImageFormat::Png,
    )
    .expect("rendered pixmap decodes")
    .into_rgba8();
    image::imageops::overlay(&mut image, &rendered, 0, 0);
    RasterIcon {
        width: image.width(),
        height: image.height(),
        rgba: image.into_raw(),
    }
}
