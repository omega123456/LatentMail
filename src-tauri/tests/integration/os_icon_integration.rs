use latentmail_lib::os::icon::{
    dot_color, dot_geometry, dot_rgb, reauthentication_overlay, tray_icon, DotColor, DotGeometry,
};

#[test]
fn dot_uses_the_ported_geometry_and_colours() {
    assert_eq!(
        dot_geometry(16),
        DotGeometry {
            radius: 4,
            center_x: 11,
            center_y: 5,
        }
    );
    assert_eq!(
        dot_geometry(32),
        DotGeometry {
            radius: 8,
            center_x: 23,
            center_y: 9,
        }
    );
    assert_eq!(dot_color(false), DotColor::Unread);
    assert_eq!(dot_rgb(DotColor::Unread), [0, 120, 212]);
    assert_eq!(dot_color(true), DotColor::Reauthentication);
    assert_eq!(dot_rgb(DotColor::Reauthentication), [211, 47, 47]);
}

#[test]
fn rendered_tray_icons_composite_the_state_dot_and_overlay_is_red() {
    let idle = tray_icon(0, false).unwrap();
    let unread = tray_icon(1, false).unwrap();
    let reauthentication = tray_icon(1, true).unwrap();
    let pixel = |icon: &latentmail_lib::os::icon::RasterIcon, x: usize, y: usize| -> [u8; 4] {
        let offset = (y * usize::try_from(icon.width).unwrap() + x) * 4;
        icon.rgba[offset..offset + 4].try_into().unwrap()
    };

    assert_eq!((idle.width, idle.height), (32, 32));
    assert_ne!(idle.rgba, unread.rgba);
    assert_eq!(pixel(&unread, 23, 9), [0, 120, 212, 255]);
    assert_eq!(pixel(&reauthentication, 23, 9), [211, 47, 47, 255]);

    let overlay = reauthentication_overlay();
    assert_eq!((overlay.width, overlay.height), (16, 16));
    assert_eq!(pixel(&overlay, 8, 8), [211, 47, 47, 255]);
    assert_eq!(pixel(&overlay, 0, 0), [0, 0, 0, 0]);
}
