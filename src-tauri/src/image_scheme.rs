use tauri::http::{Response, StatusCode};

pub const IMAGE_CACHE_CONTROL: &str = "max-age=86400";

pub struct ServedImage {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub fn proxy_url(scheme: &str, query: &str) -> String {
    if cfg!(windows) {
        format!("http://{scheme}.localhost/?{query}")
    } else {
        format!("{scheme}://localhost/?{query}")
    }
}

pub fn respond(scheme: &str, uri: &str, served: Result<ServedImage, String>) -> Response<Vec<u8>> {
    let builder = Response::builder().header("access-control-allow-origin", "*");
    match served {
        Ok(image) => builder
            .status(StatusCode::OK)
            .header("content-type", image.content_type)
            .header("cache-control", IMAGE_CACHE_CONTROL)
            .body(image.bytes),
        Err(reason) => {
            tracing::debug!("{scheme} image refused ({reason}): {uri}");
            builder.status(StatusCode::NOT_FOUND).body(Vec::new())
        }
    }
    .expect("image response builds")
}
