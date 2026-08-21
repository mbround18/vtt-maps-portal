use actix_web::{HttpRequest, HttpResponse, web};
use chrono::Utc;
use futures::TryStreamExt;
use mongodb::bson::doc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    app::AppState,
    services::{
        auth::{self, require_authenticated, require_csrf},
        policy::{self, Permission},
    },
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/account")
            .route("/interactions", web::get().to(interactions))
            .route("/export", web::get().to(export_account_data))
            .route("/delete", web::post().to(delete_account)),
    );
}

async fn find_all<T>(
    coll: &mongodb::Collection<T>,
    filter: mongodb::bson::Document,
    sort: mongodb::bson::Document,
    limit: i64,
) -> Vec<T>
where
    T: serde::de::DeserializeOwned + Unpin + Send + Sync,
{
    match coll.find(filter).sort(sort).limit(limit).await {
        Ok(c) => c.try_collect().await.unwrap_or_default(),
        Err(_) => vec![],
    }
}

async fn auth_user(
    req: &HttpRequest,
    state: &AppState,
) -> Result<(auth::SessionClaims, Uuid), HttpResponse> {
    let claims = require_authenticated(req, state).await.map_err(|_| {
        HttpResponse::Unauthorized().json(serde_json::json!({"error": "authentication required"}))
    })?;
    let user_id = Uuid::parse_str(&claims.sub).map_err(|_| {
        HttpResponse::Unauthorized().json(serde_json::json!({"error": "invalid session"}))
    })?;
    Ok((claims, user_id))
}

async fn interactions(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let (claims, user_id) = match auth_user(&req, &state).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if policy::authorize(&claims.role, Permission::AccountRead).is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "error": "role does not allow account access"
        }));
    }

    let views = state
        .views_coll()
        .count_documents(doc! {"user_id": user_id})
        .await
        .unwrap_or(0);
    let downloads = state
        .downloads_coll()
        .count_documents(doc! {"user_id": user_id})
        .await
        .unwrap_or(0);
    let votes = state
        .votes_coll()
        .count_documents(doc! {"user_id": user_id})
        .await
        .unwrap_or(0);

    let recent_views = find_all(
        &state.views_coll(),
        doc! {"user_id": user_id},
        doc! {"started_at": -1},
        50,
    )
    .await;
    let recent_downloads = find_all(
        &state.downloads_coll(),
        doc! {"user_id": user_id},
        doc! {"downloaded_at": -1},
        50,
    )
    .await;
    let recent_votes = find_all(
        &state.votes_coll(),
        doc! {"user_id": user_id},
        doc! {"created_at": -1},
        50,
    )
    .await;

    HttpResponse::Ok().json(serde_json::json!({
        "summary": {"views": views, "downloads": downloads, "votes": votes},
        "recent": {
            "views": recent_views.into_iter().map(|v| serde_json::json!({
                "map_id": v.map_id, "started_at": v.started_at, "ended_at": v.ended_at, "duration_ms": v.duration_ms
            })).collect::<Vec<_>>(),
            "downloads": recent_downloads.into_iter().map(|d| serde_json::json!({
                "map_id": d.map_id, "downloaded_at": d.downloaded_at
            })).collect::<Vec<_>>(),
            "votes": recent_votes.into_iter().map(|v| serde_json::json!({
                "map_id": v.map_id, "created_at": v.created_at
            })).collect::<Vec<_>>()
        }
    }))
}

async fn export_account_data(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let (_claims, user_id) = match auth_user(&req, &state).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let user = match state.users_coll().find_one(doc! {"_id": user_id}).await {
        Ok(Some(u)) => u,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "user not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    let views = find_all(&state.views_coll(), doc! {"user_id": user_id}, doc! {}, 0).await;
    let downloads = find_all(
        &state.downloads_coll(),
        doc! {"user_id": user_id},
        doc! {},
        0,
    )
    .await;
    let votes = find_all(&state.votes_coll(), doc! {"user_id": user_id}, doc! {}, 0).await;
    let sessions = find_all(
        &state.sessions_coll(),
        doc! {"user_id": user_id},
        doc! {},
        0,
    )
    .await;

    let response = serde_json::json!({
        "exported_at": Utc::now(),
        "user": user,
        "sessions": sessions,
        "interactions": {"views": views, "downloads": downloads, "votes": votes}
    });

    HttpResponse::Ok()
        .append_header(("Content-Type", "application/json"))
        .append_header((
            "Content-Disposition",
            format!("attachment; filename=account-export-{}.json", user_id),
        ))
        .body(response.to_string())
}

#[derive(Debug, Deserialize)]
struct DeletePayload {
    confirmation_phrase: String,
    confirm_one: bool,
    confirm_two: bool,
    confirm_three: bool,
}

async fn delete_account(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<DeletePayload>,
) -> HttpResponse {
    let (claims, user_id) = match auth_user(&req, &state).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    if policy::authorize(&claims.role, Permission::AccountDelete).is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "error": "role does not allow account deletion"
        }));
    }
    if let Err(err) = require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    if body.confirmation_phrase.trim() != "DELETE MY ACCOUNT"
        || !body.confirm_one
        || !body.confirm_two
        || !body.confirm_three
    {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "confirmation failed; pass phrase and all three confirmations are required"
        }));
    }

    let _ = state
        .sessions_coll()
        .update_many(
            doc! {"user_id": user_id},
            doc! {"$set": {"revoked_at": Utc::now(), "revoked_reason": "account_delete"}},
        )
        .await;
    let _ = state
        .votes_coll()
        .delete_many(doc! {"user_id": user_id})
        .await;
    let _ = state
        .views_coll()
        .delete_many(doc! {"user_id": user_id})
        .await;
    let _ = state
        .downloads_coll()
        .delete_many(doc! {"user_id": user_id})
        .await;

    match state.users_coll().delete_one(doc! {"_id": user_id}).await {
        Ok(r) if r.deleted_count == 0 => {
            HttpResponse::NotFound().json(serde_json::json!({"error": "user not found"}))
        }
        Ok(_) => HttpResponse::NoContent()
            .cookie(auth::clear_session_cookie(&state))
            .cookie(auth::clear_csrf_cookie(&state))
            .finish(),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}
