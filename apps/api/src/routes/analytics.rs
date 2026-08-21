use actix_web::{HttpRequest, HttpResponse, web};
use mongodb::bson::doc;
use uuid::Uuid;

use crate::{app::AppState, services::auth::require_admin};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/analytics")
            .route("/overview", web::get().to(overview))
            .route("/maps/{id}", web::get().to(map_analytics)),
    );
}

async fn overview(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let total_views = state
        .views_coll()
        .count_documents(doc! {})
        .await
        .unwrap_or(0);
    let total_downloads = state
        .downloads_coll()
        .count_documents(doc! {})
        .await
        .unwrap_or(0);
    let total_votes = state
        .votes_coll()
        .count_documents(doc! {})
        .await
        .unwrap_or(0);

    HttpResponse::Ok().json(serde_json::json!({
        "total_views": total_views,
        "total_downloads": total_downloads,
        "total_votes": total_votes,
    }))
}

async fn map_analytics(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let map_id = match Uuid::parse_str(&id) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest().json(serde_json::json!({"error": "invalid map id"}));
        }
    };

    let views = state
        .views_coll()
        .count_documents(doc! {"map_id": map_id})
        .await
        .unwrap_or(0);
    let downloads = state
        .downloads_coll()
        .count_documents(doc! {"map_id": map_id})
        .await
        .unwrap_or(0);
    let votes = state
        .votes_coll()
        .count_documents(doc! {"map_id": map_id})
        .await
        .unwrap_or(0);

    HttpResponse::Ok().json(serde_json::json!({
        "map_id": map_id,
        "views": views,
        "downloads": downloads,
        "votes": votes,
    }))
}
