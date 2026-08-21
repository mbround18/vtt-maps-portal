use actix_web::{HttpRequest, HttpResponse, web};
use chrono::Utc;
use futures::TryStreamExt;
use mongodb::bson::doc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    app::AppState,
    models::{Map, Session, SyncRun, User},
    services::{
        assets,
        auth::{require_admin, require_csrf, require_super_admin},
        cursor::{decode_timestamp_id_cursor, encode_timestamp_id_cursor},
        queue,
    },
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/admin")
            .route("/users", web::get().to(users))
            .route("/users/{id}/role", web::post().to(update_user_role))
            .route("/users/{id}/sessions", web::get().to(user_sessions))
            .route(
                "/users/{id}/sessions/{sid}",
                web::delete().to(revoke_user_session),
            )
            .route("/assets/status", web::get().to(asset_status))
            .route("/assets/sync", web::post().to(asset_sync))
            .route("/sync-runs", web::get().to(sync_runs))
            .route("/maps/metadata", web::get().to(list_map_metadata))
            .route("/maps/metadata/{id}", web::get().to(get_map_metadata))
            .route("/maps/metadata/{id}", web::post().to(update_map_metadata)),
    );
}

fn enqueue_error(err: anyhow::Error) -> HttpResponse {
    let msg = err.to_string();
    if msg.contains("already pending or running") {
        HttpResponse::Conflict().json(serde_json::json!({"error": msg}))
    } else {
        HttpResponse::InternalServerError().json(serde_json::json!({"error": msg}))
    }
}

#[derive(Debug, Deserialize, Default)]
struct UsersQuery {
    query: Option<String>,
    role: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
}

async fn users(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let query = web::Query::<UsersQuery>::from_query(req.query_string())
        .map(|q| q.into_inner())
        .unwrap_or_default();
    let search = query.query.unwrap_or_default().trim().to_string();
    let role = query.role.unwrap_or_else(|| "all".to_string());
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(50).clamp(10, 200);

    let mut filter = doc! {};
    if matches!(role.as_str(), "guest" | "user" | "contributor" | "admin") {
        filter.insert("role", &role);
    }
    if !search.is_empty() {
        let pattern = mongodb::bson::Regex {
            pattern: regex_escape(&search),
            options: "i".to_string(),
        };
        filter.insert(
            "$or",
            vec![
                doc! {"username": {"$regex": pattern.clone()}},
                doc! {"discord_id": {"$regex": pattern}},
            ],
        );
    }

    let total = state
        .users_coll()
        .count_documents(filter.clone())
        .await
        .unwrap_or(0);
    let cursor = match state
        .users_coll()
        .find(filter)
        .sort(doc! {"created_at": -1})
        .skip(((page - 1) * page_size) as u64)
        .limit(page_size)
        .await
    {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    match cursor.try_collect::<Vec<User>>().await {
        Ok(rows) => {
            let mapped = rows
                .into_iter()
                .map(|u| {
                    serde_json::json!({
                        "id": u.id,
                        "discord_id": u.discord_id,
                        "username": u.username,
                        "role": u.role,
                        "created_at": u.created_at,
                        "updated_at": u.updated_at
                    })
                })
                .collect::<Vec<_>>();
            HttpResponse::Ok().json(serde_json::json!({
                "items": mapped.clone(),
                "next_cursor": serde_json::Value::Null,
                "prev_cursor": serde_json::Value::Null,
                "users": mapped,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": ((total as i64) + page_size - 1) / page_size.max(1),
                    "query": search,
                    "role": role
                }
            }))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

fn regex_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        if "\\.^$|()[]{}*+?".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[derive(Deserialize)]
struct RolePayload {
    role: String,
}

async fn update_user_role(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
    body: web::Json<RolePayload>,
) -> HttpResponse {
    let actor = match require_admin(&req, &state).await {
        Ok(actor) => actor,
        Err(_) => {
            return HttpResponse::Forbidden()
                .json(serde_json::json!({"error": "admin role required"}));
        }
    };
    if let Err(err) = require_csrf(&req, &state, &actor).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    let role = body.role.trim();
    if !["admin", "contributor", "user", "guest"].contains(&role) {
        return HttpResponse::BadRequest().json(serde_json::json!({"error": "invalid role"}));
    }

    let user_id = match Uuid::parse_str(&id) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "invalid user id"}));
        }
    };

    let result = state
        .users_coll()
        .update_one(
            doc! {"_id": user_id},
            doc! {"$set": {"role": role, "updated_at": Utc::now()}},
        )
        .await;

    match result {
        Ok(r) if r.matched_count == 0 => {
            HttpResponse::NotFound().json(serde_json::json!({"error": "user not found"}))
        }
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({"user_id": user_id, "role": role})),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn asset_status(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let total = state
        .maps_coll()
        .count_documents(doc! {})
        .await
        .unwrap_or(0);
    let pending = state
        .maps_coll()
        .count_documents(doc! {"status": "pending"})
        .await
        .unwrap_or(0);
    let processing = state
        .maps_coll()
        .count_documents(doc! {"status": "processing"})
        .await
        .unwrap_or(0);
    let ready = state
        .maps_coll()
        .count_documents(doc! {"status": "ready"})
        .await
        .unwrap_or(0);
    let error = state
        .maps_coll()
        .count_documents(doc! {"status": "error"})
        .await
        .unwrap_or(0);

    let last_run = state
        .sync_runs_coll()
        .find_one(doc! {})
        .sort(doc! {"started_at": -1})
        .await
        .ok()
        .flatten();

    HttpResponse::Ok().json(serde_json::json!({
        "github_url": state.config.github_url,
        "branch": state.config.github_branch,
        "last_sync_run": last_run,
        "maps": {
            "total": total,
            "pending": pending,
            "processing": processing,
            "ready": ready,
            "error": error
        }
    }))
}

async fn asset_sync(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let claims = match require_admin(&req, &state).await {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Forbidden()
                .json(serde_json::json!({"error": "admin role required"}));
        }
    };
    if let Err(err) = require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    match queue::enqueue_job(&state, "sync_maps", serde_json::json!({})).await {
        Ok(job_id) => HttpResponse::Accepted().json(serde_json::json!({
            "job_id": job_id,
            "status": "pending"
        })),
        Err(err) => enqueue_error(err),
    }
}

#[derive(Debug, Deserialize, Default)]
struct CursorQuery {
    cursor: Option<String>,
    limit: Option<i64>,
}

async fn sync_runs(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let query = web::Query::<CursorQuery>::from_query(req.query_string())
        .map(|q| q.into_inner())
        .unwrap_or_default();
    let limit = query.limit.unwrap_or(50).clamp(1, 200);

    let mut filter = doc! {};
    if let Some((c_at, c_id)) = query.cursor.as_deref().and_then(decode_timestamp_id_cursor) {
        filter = doc! {"$or": [
            {"started_at": {"$lt": c_at}},
            {"started_at": c_at, "_id": {"$lt": c_id}},
        ]};
    }

    let cursor = match state
        .sync_runs_coll()
        .find(filter)
        .sort(doc! {"started_at": -1, "_id": -1})
        .limit(limit)
        .await
    {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    match cursor.try_collect::<Vec<SyncRun>>().await {
        Ok(rows) => {
            let next_cursor = rows
                .last()
                .map(|r| encode_timestamp_id_cursor(r.started_at, r.id));
            HttpResponse::Ok().json(serde_json::json!({
                "items": rows,
                "next_cursor": next_cursor,
                "prev_cursor": serde_json::Value::Null
            }))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn list_map_metadata(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if require_super_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden()
            .json(serde_json::json!({"error": "super admin role required"}));
    }
    let cursor = match state.maps_coll().find(doc! {}).sort(doc! {"name": 1}).await {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    match cursor.try_collect::<Vec<Map>>().await {
        Ok(rows) => HttpResponse::Ok().json(serde_json::json!({
            "maps": rows.into_iter().map(|m| serde_json::json!({
                "id": m.id,
                "path": m.path,
                "display_name": m.name,
                "tags": m.tags,
                "status": m.status,
                "updated_at": m.updated_at
            })).collect::<Vec<_>>()
        })),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn get_map_metadata(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
) -> HttpResponse {
    if require_super_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden()
            .json(serde_json::json!({"error": "super admin role required"}));
    }
    match assets::find_map_by_id(&state, &id).await {
        Ok(Some(m)) => HttpResponse::Ok().json(serde_json::json!({
            "id": m.id,
            "path": m.path,
            "display_name": m.name,
            "tags": m.tags,
            "about_md": m.about_md,
            "poi": m.poi,
            "updated_at": m.updated_at
        })),
        Ok(None) => {
            HttpResponse::NotFound().json(serde_json::json!({"error":"map metadata not found"}))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

#[derive(Debug, Deserialize)]
struct UpdateMapMetadataPayload {
    display_name: Option<String>,
    tags: Option<Vec<String>>,
    about_md: Option<String>,
    poi: Option<serde_json::Value>,
}

async fn update_map_metadata(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
    payload: web::Json<UpdateMapMetadataPayload>,
) -> HttpResponse {
    let claims = match require_super_admin(&req, &state).await {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Forbidden()
                .json(serde_json::json!({"error": "super admin role required"}));
        }
    };
    if let Err(err) = require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    let map = match assets::find_map_by_id(&state, &id).await {
        Ok(Some(m)) => m,
        Ok(None) => {
            return HttpResponse::NotFound()
                .json(serde_json::json!({"error":"map metadata not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    let mut set_doc = doc! {"updated_at": Utc::now()};
    if let Some(name) = &payload.display_name {
        set_doc.insert("name", name);
    }
    if let Some(tags) = &payload.tags {
        set_doc.insert("tags", tags);
    }
    if let Some(about_md) = &payload.about_md {
        set_doc.insert("about_md", about_md);
    }
    if let Some(poi) = &payload.poi {
        set_doc.insert(
            "poi",
            mongodb::bson::to_bson(poi).unwrap_or(mongodb::bson::Bson::Null),
        );
    }

    let updated = state
        .maps_coll()
        .update_one(doc! {"_id": map.id}, doc! {"$set": set_doc})
        .await;

    match updated {
        Ok(r) if r.matched_count == 0 => {
            HttpResponse::NotFound().json(serde_json::json!({"error":"map metadata not found"}))
        }
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({"status":"ok", "map_id": map.id})),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn user_sessions(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let user_id = match Uuid::parse_str(&id) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "invalid user id"}));
        }
    };

    let cursor = match state
        .sessions_coll()
        .find(doc! {"user_id": user_id})
        .sort(doc! {"created_at": -1})
        .limit(100)
        .await
    {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    match cursor.try_collect::<Vec<Session>>().await {
        Ok(rows) => HttpResponse::Ok().json(serde_json::json!({
            "sessions": rows.into_iter().map(|s| serde_json::json!({
                "id": s.id,
                "created_at": s.created_at,
                "expires_at": s.expires_at,
                "last_seen_at": s.last_seen_at,
                "revoked_at": s.revoked_at,
                "revoked_reason": s.revoked_reason,
                "active": s.revoked_at.is_none() && s.expires_at > Utc::now()
            })).collect::<Vec<_>>()
        })),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn revoke_user_session(
    state: web::Data<AppState>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> HttpResponse {
    let claims = match require_admin(&req, &state).await {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Forbidden()
                .json(serde_json::json!({"error": "admin role required"}));
        }
    };
    if let Err(err) = require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    let (user_id_raw, session_id_raw) = path.into_inner();
    let user_id = match Uuid::parse_str(&user_id_raw) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "invalid user id"}));
        }
    };
    let session_id = match Uuid::parse_str(&session_id_raw) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "invalid session id"}));
        }
    };

    let updated = state
        .sessions_coll()
        .update_one(
            doc! {"_id": session_id, "user_id": user_id},
            doc! {"$set": {"revoked_at": Utc::now(), "revoked_reason": "admin_revoke"}},
        )
        .await;

    match updated {
        Ok(r) if r.matched_count == 0 => {
            HttpResponse::NotFound().json(serde_json::json!({"error": "session not found"}))
        }
        Ok(_) => {
            HttpResponse::Ok().json(serde_json::json!({"revoked": true, "session_id": session_id}))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}
