use actix_web::{HttpRequest, HttpResponse, http::header, web};
use mongodb::bson::doc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{app::AppState, models::Session, services::auth, services::policy};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/auth")
            .route("/discord/start", web::post().to(discord_start))
            .route("/discord/callback", web::get().to(discord_callback))
            .route("/me", web::get().to(me))
            .route("/csrf", web::get().to(csrf))
            .route("/logout", web::post().to(logout))
            .route("/sessions", web::get().to(sessions))
            .route("/sessions/others", web::delete().to(revoke_other_sessions))
            .route("/sessions/{id}", web::delete().to(revoke_session)),
    );
}

fn sessions_coll(state: &AppState) -> mongodb::Collection<Session> {
    state.db.collection("sessions")
}

async fn discord_start(state: web::Data<AppState>) -> HttpResponse {
    match auth::issue_oauth_state(&state).await {
        Ok(oauth_state) => {
            let auth_url = auth::make_oauth_url(&state, &oauth_state);
            HttpResponse::Ok()
                .cookie(auth::make_state_cookie(&state, &oauth_state))
                .json(serde_json::json!({"auth_url": auth_url}))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: String,
    state: String,
}

async fn discord_callback(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<CallbackQuery>,
) -> HttpResponse {
    let state_cookie = req
        .cookie(auth::OAUTH_STATE_COOKIE)
        .map(|c| c.value().to_string());

    if let Some(cookie_state) = state_cookie.as_deref()
        && cookie_state != query.state.as_str()
    {
        return HttpResponse::Unauthorized()
            .json(serde_json::json!({"error": "invalid oauth state"}));
    }

    let result = async {
        auth::consume_oauth_state(&state, &query.state).await?;
        let access_token = auth::exchange_code_for_token(&state, &query.code).await?;
        let profile = auth::fetch_discord_user(&access_token).await?;
        let user = auth::upsert_user_from_discord(&state, &profile).await?;
        let (token, csrf_token) = auth::create_session_for_user(&state, &user).await?;
        Ok::<_, anyhow::Error>((token, csrf_token))
    }
    .await;

    match result {
        Ok((token, csrf_token)) => HttpResponse::Found()
            .append_header((header::LOCATION, "/catalog"))
            .cookie(auth::make_session_cookie(&state, &token))
            .cookie(auth::make_csrf_cookie(&state, &csrf_token))
            .cookie(auth::clear_state_cookie(&state))
            .finish(),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn me(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    match auth::require_authenticated(&req, &state).await {
        Ok(claims) => {
            let is_super_admin =
                auth::is_super_admin(&state.config.super_admin_discord_id, &claims);
            let avatar_url = match Uuid::parse_str(&claims.sub) {
                Ok(id) => auth::find_user_by_id(&state, id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|user| user.avatar_url),
                Err(_) => None,
            };
            HttpResponse::Ok().json(serde_json::json!({
                "authenticated": true,
                "user": {
                    "id": claims.sub,
                    "discord_id": claims.discord_id,
                    "username": claims.username,
                    "role": claims.role,
                    "is_super_admin": is_super_admin,
                    "avatar_url": avatar_url
                }
            }))
        }
        Err(_) => {
            HttpResponse::Ok().json(serde_json::json!({"authenticated": false, "user": null}))
        }
    }
}

async fn csrf(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    match auth::require_authenticated(&req, &state).await {
        Ok(_) => {
            let token = req.cookie(auth::CSRF_COOKIE).map(|c| c.value().to_string());
            HttpResponse::Ok().json(serde_json::json!({"csrf_token": token}))
        }
        Err(_) => HttpResponse::Unauthorized().json(serde_json::json!({"error": "unauthorized"})),
    }
}

async fn logout(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if let Ok(claims) = auth::require_authenticated(&req, &state).await
        && auth::require_csrf(&req, &state, &claims).await.is_ok()
    {
        let _ = auth::revoke_session(&state, &claims, "logout").await;
    }

    HttpResponse::NoContent()
        .cookie(auth::clear_session_cookie(&state))
        .cookie(auth::clear_state_cookie(&state))
        .cookie(auth::clear_csrf_cookie(&state))
        .finish()
}

async fn sessions(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let claims = match auth::require_authenticated(&req, &state).await {
        Ok(claims) => claims,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "authentication required"}));
        }
    };

    let user_id = match Uuid::parse_str(&claims.sub) {
        Ok(id) => id,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "invalid session"}));
        }
    };

    use futures::TryStreamExt;
    let cursor = match sessions_coll(&state)
        .find(doc! {"user_id": user_id})
        .sort(doc! {"created_at": -1})
        .limit(50)
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
            "sessions": rows.into_iter().map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "created_at": s.created_at,
                    "expires_at": s.expires_at,
                    "last_seen_at": s.last_seen_at,
                    "revoked_at": s.revoked_at,
                    "revoked_reason": s.revoked_reason,
                    "current": claims.sid == s.id.to_string(),
                    "active": s.revoked_at.is_none() && s.expires_at > chrono::Utc::now(),
                })
            }).collect::<Vec<_>>()
        })),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn revoke_session(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
) -> HttpResponse {
    let claims = match auth::require_authenticated(&req, &state).await {
        Ok(claims) => claims,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "authentication required"}));
        }
    };
    if let Err(err) = auth::require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    let actor_id = match Uuid::parse_str(&claims.sub) {
        Ok(id) => id,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "invalid session"}));
        }
    };

    let session_id = match Uuid::parse_str(&id) {
        Ok(id) => id,
        Err(_) => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "invalid session id"}));
        }
    };

    let existing = match sessions_coll(&state)
        .find_one(doc! {"_id": session_id})
        .await
    {
        Ok(Some(s)) => s,
        Ok(None) => {
            return HttpResponse::NotFound()
                .json(serde_json::json!({"error": "session not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    if existing.user_id != actor_id
        && policy::authorize(&claims.role, policy::Permission::AdminWrite).is_err()
    {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "forbidden"}));
    }

    let updated = sessions_coll(&state)
        .update_one(
            doc! {"_id": session_id},
            doc! {"$set": {"revoked_at": chrono::Utc::now(), "revoked_reason": "user_revoke"}},
        )
        .await;

    match updated {
        Ok(result) if result.modified_count == 0 => {
            HttpResponse::NotFound().json(serde_json::json!({"error": "session not found"}))
        }
        Ok(_) => {
            let mut response = HttpResponse::Ok();
            if claims.sid == session_id.to_string() {
                response.cookie(auth::clear_session_cookie(&state));
                response.cookie(auth::clear_csrf_cookie(&state));
            }
            response.json(serde_json::json!({"revoked": true, "session_id": session_id}))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn revoke_other_sessions(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let claims = match auth::require_authenticated(&req, &state).await {
        Ok(claims) => claims,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "authentication required"}));
        }
    };
    if let Err(err) = auth::require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    let actor_id = match Uuid::parse_str(&claims.sub) {
        Ok(id) => id,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "invalid session"}));
        }
    };
    let current_sid = match Uuid::parse_str(&claims.sid) {
        Ok(id) => id,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "invalid session"}));
        }
    };

    let updated = sessions_coll(&state)
        .update_many(
            doc! {"user_id": actor_id, "_id": {"$ne": current_sid}, "revoked_at": null},
            doc! {"$set": {"revoked_at": chrono::Utc::now(), "revoked_reason": "user_revoke_others"}},
        )
        .await;

    match updated {
        Ok(result) => {
            HttpResponse::Ok().json(serde_json::json!({"revoked": result.modified_count}))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}
