use actix_web::{HttpResponse, http::header, web};

use crate::{app::AppState, services::assets};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::scope("/assets").route("/{key:.*}", web::get().to(get_asset)));
}

/// Public (unauthenticated) proxy for map images/thumbnails stored in
/// RustFS -- see `services::assets::public_url_for_key`. RustFS itself has
/// no public network exposure; this is the only path bytes take out of it
/// for anonymous viewers, mirroring what the bucket's old public-read
/// policy allowed before it was replaced by this proxy.
async fn get_asset(state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let key = path.into_inner();
    match assets::download_object(&state, &key).await {
        Ok(Some(obj)) => HttpResponse::Ok()
            .content_type(obj.content_type.as_str())
            .append_header((header::CACHE_CONTROL, "public, max-age=31536000, immutable"))
            .body(obj.bytes),
        Ok(None) => HttpResponse::NotFound().json(serde_json::json!({"error": "asset not found"})),
        Err(err) => {
            tracing::error!("failed to proxy rustfs asset {key}: {err:#}");
            HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": "asset unavailable"}))
        }
    }
}
