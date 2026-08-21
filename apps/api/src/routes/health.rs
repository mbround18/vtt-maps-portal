use actix_web::{HttpResponse, web};

use crate::{app::AppState, db};

pub async fn liveness() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({"status": "ok"}))
}

pub async fn readiness(state: web::Data<AppState>) -> HttpResponse {
    match db::ping(&state.db).await {
        Ok(()) => HttpResponse::Ok().json(serde_json::json!({"status": "ready"})),
        Err(err) => HttpResponse::ServiceUnavailable().json(serde_json::json!({
            "status": "not_ready",
            "error": err.to_string()
        })),
    }
}
