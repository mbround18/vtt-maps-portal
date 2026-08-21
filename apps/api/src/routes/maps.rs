use std::collections::HashSet;

use actix_web::{HttpRequest, HttpResponse, http::header, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use futures::TryStreamExt;
use mongodb::bson::doc;
use pulldown_cmark::{Options, Parser, html};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    app::AppState,
    models::{Map, MapDownload, MapView, MapVote},
    services::{
        assets,
        auth::{require_authenticated, require_csrf},
        policy::{self, Permission},
        privacy,
    },
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/maps")
            .route("", web::get().to(list_maps))
            .route("/{id:.*}/related", web::get().to(related_maps))
            .route("/{id:.*}/asset", web::get().to(download_asset_file))
            .route("/{id:.*}/view-start", web::post().to(view_start))
            .route("/{id:.*}/view-end", web::post().to(view_end))
            .route("/{id:.*}/download", web::post().to(download))
            .route("/{id:.*}/vote", web::post().to(vote))
            .route("/{id:.*}/vote", web::delete().to(unvote))
            .route("/{id:.*}", web::get().to(get_map)),
    );
}

fn maps_coll(state: &AppState) -> mongodb::Collection<Map> {
    state.db.collection("maps")
}
fn views_coll(state: &AppState) -> mongodb::Collection<MapView> {
    state.db.collection("views")
}
fn downloads_coll(state: &AppState) -> mongodb::Collection<MapDownload> {
    state.db.collection("downloads")
}
fn votes_coll(state: &AppState) -> mongodb::Collection<MapVote> {
    state.db.collection("votes")
}

fn map_id_from_req(req: &HttpRequest) -> String {
    req.match_info().get("id").unwrap_or_default().to_string()
}

fn encode_map_cursor(path: &str) -> String {
    URL_SAFE_NO_PAD.encode(path.as_bytes())
}

fn decode_map_cursor(cursor: &str) -> Option<String> {
    let raw = URL_SAFE_NO_PAD.decode(cursor).ok()?;
    String::from_utf8(raw).ok()
}

fn render_about_html(markdown: &str) -> String {
    if markdown.trim().is_empty() {
        return String::new();
    }
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(markdown, options);
    let mut raw_html = String::new();
    html::push_html(&mut raw_html, parser);
    ammonia::clean(&raw_html)
}

fn related_score(current: &Map, candidate: &Map) -> i32 {
    if current.id == candidate.id || current.path == candidate.path {
        return -1;
    }
    let current_tags: HashSet<String> = current
        .tags
        .iter()
        .map(|t| t.to_ascii_lowercase())
        .collect();
    let mut score = 0_i32;

    for tag in &candidate.tags {
        if current_tags.contains(&tag.to_ascii_lowercase()) {
            score += 4;
        }
    }

    let current_prefix = current
        .path
        .split('/')
        .take(2)
        .collect::<Vec<_>>()
        .join("/");
    if !current_prefix.is_empty() && candidate.path.starts_with(&current_prefix) {
        score += 3;
    }

    let current_head = current
        .name
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let candidate_head = candidate
        .name
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !current_head.is_empty() && current_head == candidate_head {
        score += 1;
    }
    score
}

fn map_summary_json(state: &AppState, map: &Map) -> serde_json::Value {
    serde_json::json!({
        "id": map.id,
        "path": map.path,
        "name": map.name,
        "tags": map.tags,
        "status": map.status,
        "thumb_url": map.thumb_key.as_ref().map(|k| assets::public_url_for_key(state, k)),
    })
}

#[derive(Deserialize, Default)]
struct ListMapsQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn list_maps(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let query = web::Query::<ListMapsQuery>::from_query(req.query_string())
        .map(|q| q.into_inner())
        .unwrap_or_default();

    let cursor = match maps_coll(&state).find(doc! {}).sort(doc! {"path": 1}).await {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    let maps: Vec<Map> = match cursor.try_collect().await {
        Ok(v) => v,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    let total = maps.len();

    if query.cursor.is_none() && query.limit.is_none() {
        let items = maps
            .iter()
            .map(|m| map_summary_json(&state, m))
            .collect::<Vec<_>>();
        return HttpResponse::Ok()
            .append_header((header::CACHE_CONTROL, "public, max-age=30"))
            .json(serde_json::json!({"maps": items.clone(), "items": items, "next_cursor": null, "prev_cursor": null, "total": total}));
    }

    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let start = query
        .cursor
        .as_deref()
        .and_then(decode_map_cursor)
        .and_then(|last| maps.iter().position(|m| m.path == last).map(|idx| idx + 1))
        .unwrap_or(0);
    let end = (start + limit).min(maps.len());
    let items = maps[start..end]
        .iter()
        .map(|m| map_summary_json(&state, m))
        .collect::<Vec<_>>();
    let next_cursor = if end < maps.len() && !maps[start..end].is_empty() {
        Some(encode_map_cursor(&maps[end - 1].path))
    } else {
        None
    };

    HttpResponse::Ok()
        .append_header((header::CACHE_CONTROL, "public, max-age=30"))
        .json(serde_json::json!({
            "items": items.clone(),
            "next_cursor": next_cursor,
            "prev_cursor": serde_json::Value::Null,
            "maps": items,
            "total": total
        }))
}

async fn map_stats(state: &AppState, map_id: Uuid) -> serde_json::Value {
    let views = views_coll(state)
        .count_documents(doc! {"map_id": map_id})
        .await
        .unwrap_or(0);
    let downloads = downloads_coll(state)
        .count_documents(doc! {"map_id": map_id})
        .await
        .unwrap_or(0);
    let votes = votes_coll(state)
        .count_documents(doc! {"map_id": map_id})
        .await
        .unwrap_or(0);
    serde_json::json!({"views": views, "downloads": downloads, "votes": votes})
}

async fn user_voted_for_map(state: &AppState, req: &HttpRequest, map_id: Uuid) -> bool {
    let Some(uid) = require_authenticated(req, state)
        .await
        .ok()
        .and_then(|claims| Uuid::parse_str(&claims.sub).ok())
    else {
        return false;
    };
    votes_coll(state)
        .find_one(doc! {"map_id": map_id, "user_id": uid})
        .await
        .ok()
        .flatten()
        .is_some()
}

async fn get_map(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let map_id = map_id_from_req(&req);
    let map = match assets::find_map_by_id(&state, &map_id).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    let about_html = render_about_html(&map.about_md);
    let mut map_json = serde_json::to_value(&map).unwrap_or_else(|_| serde_json::json!({}));
    if let serde_json::Value::Object(ref mut obj) = map_json {
        obj.insert(
            "about_html".to_string(),
            serde_json::Value::String(about_html),
        );
    }

    let preview = if map.status == "ready" {
        serde_json::json!({
            "available": true,
            "width": map.width,
            "height": map.height,
            "image_url": map.image_key.as_ref().map(|k| assets::public_url_for_key(&state, k)),
            "thumb_url": map.thumb_key.as_ref().map(|k| assets::public_url_for_key(&state, k)),
            "dd2vtt_download_url": format!("/api/v1/maps/{}/asset", map.id),
        })
    } else {
        serde_json::json!({"available": false, "status": map.status, "error": map.error})
    };

    let stats = map_stats(&state, map.id).await;
    let user_voted = user_voted_for_map(&state, &req, map.id).await;

    HttpResponse::Ok().json(serde_json::json!({
        "map": map_json,
        "preview": preview,
        "donation_url": state.config.kofi_url,
        "stats": stats,
        "user_voted": user_voted,
    }))
}

#[derive(Deserialize, Default)]
struct RelatedMapsQuery {
    limit: Option<usize>,
}

async fn related_maps(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let query = web::Query::<RelatedMapsQuery>::from_query(req.query_string())
        .map(|q| q.into_inner())
        .unwrap_or_default();
    let limit = query.limit.unwrap_or(8).clamp(1, 24);

    let map_id = map_id_from_req(&req);
    let target = match assets::find_map_by_id(&state, &map_id).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    let cursor = match maps_coll(&state).find(doc! {}).await {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    let all: Vec<Map> = match cursor.try_collect().await {
        Ok(v) => v,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    let mut ranked = all
        .into_iter()
        .map(|candidate| {
            let score = related_score(&target, &candidate);
            (candidate, score)
        })
        .filter(|(_, score)| *score > 0)
        .collect::<Vec<_>>();
    ranked.sort_by(|(a_map, a_score), (b_map, b_score)| {
        b_score
            .cmp(a_score)
            .then_with(|| a_map.name.cmp(&b_map.name))
    });

    let items = ranked
        .into_iter()
        .take(limit)
        .map(|(m, _)| map_summary_json(&state, &m))
        .collect::<Vec<_>>();

    HttpResponse::Ok()
        .append_header((header::CACHE_CONTROL, "public, max-age=60"))
        .json(serde_json::json!({"items": items.clone(), "maps": items}))
}

async fn download_asset_file(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let claims = match require_authenticated(&req, &state).await {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "authentication required for dd2vtt download"}));
        }
    };
    if policy::authorize(&claims.role, Permission::MapDd2vttDownload).is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "error": "role does not allow dd2vtt download"
        }));
    }

    let map_id = map_id_from_req(&req);
    let map = match assets::find_map_by_id(&state, &map_id).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    match assets::presigned_asset_url(&state, &map.source_key).await {
        Ok(url) => HttpResponse::Found()
            .append_header((header::LOCATION, url))
            .finish(),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

#[derive(Deserialize)]
struct ViewStartPayload {
    session_id: String,
}

async fn view_start(
    state: web::Data<AppState>,
    req: HttpRequest,
    payload: web::Json<ViewStartPayload>,
) -> HttpResponse {
    let map_id_raw = map_id_from_req(&req);
    let map = match assets::find_map_by_id(&state, &map_id_raw).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    if !privacy::analytics_consent_granted(&req) {
        return HttpResponse::Accepted()
            .json(serde_json::json!({"status": "accepted", "tracked": false}));
    }

    let user_id = require_authenticated(&req, &state)
        .await
        .ok()
        .and_then(|claims| Uuid::parse_str(&claims.sub).ok());

    let record = MapView {
        id: Some(Uuid::new_v4()),
        map_id: map.id,
        user_id,
        session_id: payload.session_id.clone(),
        started_at: Utc::now(),
        ended_at: None,
        duration_ms: None,
    };

    match views_coll(&state).insert_one(&record).await {
        Ok(_) => HttpResponse::Accepted().json(serde_json::json!({"status": "accepted"})),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

#[derive(Deserialize)]
struct ViewEndPayload {
    session_id: String,
    duration_ms: i64,
}

async fn view_end(
    state: web::Data<AppState>,
    req: HttpRequest,
    payload: web::Json<ViewEndPayload>,
) -> HttpResponse {
    let map_id_raw = map_id_from_req(&req);
    let map = match assets::find_map_by_id(&state, &map_id_raw).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    if !privacy::analytics_consent_granted(&req) {
        return HttpResponse::Accepted()
            .json(serde_json::json!({"status": "accepted", "tracked": false}));
    }

    let update = views_coll(&state)
        .update_one(
            doc! {"map_id": map.id, "session_id": &payload.session_id, "ended_at": null},
            doc! {"$set": {"ended_at": Utc::now(), "duration_ms": payload.duration_ms.max(0)}},
        )
        .await;

    match update {
        Ok(_) => HttpResponse::Accepted().json(serde_json::json!({"status": "accepted"})),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn download(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let map_id_raw = map_id_from_req(&req);
    let map = match assets::find_map_by_id(&state, &map_id_raw).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    if !privacy::analytics_consent_granted(&req) {
        return HttpResponse::Accepted()
            .json(serde_json::json!({"status": "accepted", "tracked": false}));
    }

    let claims = match require_authenticated(&req, &state).await {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "authentication required for dd2vtt download"}));
        }
    };
    if policy::authorize(&claims.role, Permission::MapDd2vttDownload).is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "error": "role does not allow dd2vtt download"
        }));
    }

    let user_id = Uuid::parse_str(&claims.sub).ok();
    let record = MapDownload {
        id: Some(Uuid::new_v4()),
        map_id: map.id,
        user_id,
        downloaded_at: Utc::now(),
    };

    match downloads_coll(&state).insert_one(&record).await {
        Ok(_) => HttpResponse::Accepted().json(serde_json::json!({"status": "tracked"})),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn vote(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let map_id_raw = map_id_from_req(&req);
    let map = match assets::find_map_by_id(&state, &map_id_raw).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    let claims = match require_authenticated(&req, &state).await {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "authentication required"}));
        }
    };
    if policy::authorize(&claims.role, Permission::MapVote).is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "error": "role does not allow voting"
        }));
    }
    if let Err(err) = require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    let user_id = match Uuid::parse_str(&claims.sub) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "invalid session"}));
        }
    };

    let existing = votes_coll(&state)
        .find_one(doc! {"map_id": map.id, "user_id": user_id})
        .await
        .ok()
        .flatten();
    if existing.is_none() {
        let record = MapVote {
            id: Some(Uuid::new_v4()),
            map_id: map.id,
            user_id,
            created_at: Utc::now(),
        };
        if let Err(err) = votes_coll(&state).insert_one(&record).await {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    }

    HttpResponse::Created().json(serde_json::json!({"voted": true}))
}

async fn unvote(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let map_id_raw = map_id_from_req(&req);
    let map = match assets::find_map_by_id(&state, &map_id_raw).await {
        Ok(Some(map)) => map,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({"error": "map not found"}));
        }
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };
    let claims = match require_authenticated(&req, &state).await {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "authentication required"}));
        }
    };
    if policy::authorize(&claims.role, Permission::MapVote).is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "error": "role does not allow voting"
        }));
    }
    if let Err(err) = require_csrf(&req, &state, &claims).await {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": err.to_string()}));
    }

    let user_id = match Uuid::parse_str(&claims.sub) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({"error": "invalid session"}));
        }
    };

    match votes_coll(&state)
        .delete_one(doc! {"map_id": map.id, "user_id": user_id})
        .await
    {
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({"voted": false})),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::related_score;
    use crate::models::Map;
    use chrono::Utc;
    use uuid::Uuid;

    fn map(path: &str, name: &str, tags: &[&str]) -> Map {
        Map {
            id: Uuid::new_v4(),
            path: path.to_string(),
            name: name.to_string(),
            tags: tags.iter().map(|v| (*v).to_string()).collect(),
            about_md: String::new(),
            poi: serde_json::json!([]),
            source_key: String::new(),
            image_key: None,
            thumb_key: None,
            width: None,
            height: None,
            status: "ready".to_string(),
            error: None,
            discovered_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn related_score_prefers_shared_tags_and_prefix() {
        let current = map(
            "dungeons/dwarven-forge/dwarven-forge.dd2vtt",
            "Dwarven Forge",
            &["Dungeons", "Dwarven Forge"],
        );
        let close = map(
            "dungeons/dwarven-ruins/forge-ruins.dd2vtt",
            "Forge Ruins",
            &["Dungeons", "Forge"],
        );
        let distant = map(
            "beach/sunrise/simple-beach.dd2vtt",
            "Simple Beach",
            &["Beach", "Sunrise"],
        );

        assert!(related_score(&current, &close) > related_score(&current, &distant));
        assert!(related_score(&current, &current) < 0);
    }
}
