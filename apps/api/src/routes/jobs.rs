use std::{convert::Infallible, time::Duration};

use actix_web::{HttpRequest, HttpResponse, web};
use actix_web_lab::sse::{self, Sse};
use futures::TryStreamExt;
use mongodb::bson::doc;
use tokio::{sync::mpsc, time::sleep};
use uuid::Uuid;

use crate::{
    app::AppState,
    models::Job,
    services::{
        auth::{require_admin, require_csrf},
        cursor::{decode_timestamp_id_cursor, encode_timestamp_id_cursor},
        queue,
    },
};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/admin/jobs")
            .route("", web::get().to(list_recent))
            .route("/{id}", web::get().to(status))
            .route("/{id}/cancel", web::post().to(cancel))
            .route("/{id}/retry", web::post().to(retry))
            .route("/{id}/stream", web::get().to(stream_status)),
    );
}

#[derive(Debug, serde::Deserialize)]
struct JobsQuery {
    cursor: Option<String>,
    limit: Option<i64>,
}

fn job_json(job: &Job) -> serde_json::Value {
    serde_json::json!({
        "id": job.id,
        "job_type": job.job_type,
        "status": job.status,
        "payload": job.payload,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "cancel_requested": job.cancel_requested,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "error": job.error,
        "created_at": job.created_at,
        "progress": job.progress,
    })
}

async fn list_recent(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let query = web::Query::<JobsQuery>::from_query(req.query_string())
        .map(|q| q.into_inner())
        .unwrap_or(JobsQuery {
            cursor: None,
            limit: Some(100),
        });
    let limit = query.limit.unwrap_or(50).clamp(1, 200);

    let mut filter = doc! {};
    if let Some((c_at, c_id)) = query.cursor.as_deref().and_then(decode_timestamp_id_cursor) {
        filter = doc! {"$or": [
            {"created_at": {"$lt": c_at}},
            {"created_at": c_at, "_id": {"$lt": c_id}},
        ]};
    }

    let cursor = match state
        .jobs_coll()
        .find(filter)
        .sort(doc! {"created_at": -1, "_id": -1})
        .limit(limit)
        .await
    {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": err.to_string()}));
        }
    };

    match cursor.try_collect::<Vec<Job>>().await {
        Ok(rows) => {
            let jobs = rows.iter().map(job_json).collect::<Vec<_>>();
            let next_cursor = rows
                .last()
                .map(|r| encode_timestamp_id_cursor(r.created_at, r.id));
            HttpResponse::Ok().json(serde_json::json!({
                "items": jobs.clone(),
                "next_cursor": next_cursor,
                "prev_cursor": serde_json::Value::Null,
                "jobs": jobs
            }))
        }
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn status(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
) -> HttpResponse {
    if require_admin(&req, &state).await.is_err() {
        return HttpResponse::Forbidden().json(serde_json::json!({"error": "admin role required"}));
    }

    let job_id = match Uuid::parse_str(&id) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest().json(serde_json::json!({"error": "invalid job id"}));
        }
    };

    match state.jobs_coll().find_one(doc! {"_id": job_id}).await {
        Ok(Some(job)) => HttpResponse::Ok().json(job_json(&job)),
        Ok(None) => HttpResponse::NotFound().json(serde_json::json!({"error": "job not found"})),
        Err(err) => {
            HttpResponse::InternalServerError().json(serde_json::json!({"error": err.to_string()}))
        }
    }
}

async fn stream_status(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
) -> Result<Sse<impl futures::Stream<Item = Result<sse::Event, Infallible>>>, actix_web::Error> {
    if require_admin(&req, &state).await.is_err() {
        return Err(actix_web::error::ErrorForbidden("admin role required"));
    }

    let job_id =
        Uuid::parse_str(&id).map_err(|_| actix_web::error::ErrorBadRequest("invalid job id"))?;

    let (tx, rx) = mpsc::channel(16);
    let state = state.clone();

    tokio::spawn(async move {
        loop {
            let job = state
                .jobs_coll()
                .find_one(doc! {"_id": job_id})
                .await
                .ok()
                .flatten();
            let Some(job) = job else {
                let _ = tx
                    .send(sse::Event::Data(sse::Data::new(
                        serde_json::json!({"error": "job not found"}).to_string(),
                    )))
                    .await;
                break;
            };
            let terminal = matches!(job.status.as_str(), "completed" | "failed" | "cancelled");
            if tx
                .send(sse::Event::Data(sse::Data::new(job_json(&job).to_string())))
                .await
                .is_err()
            {
                break;
            }
            if terminal {
                break;
            }
            sleep(Duration::from_secs(1)).await;
        }
    });

    Ok(Sse::from_infallible_receiver(rx).with_keep_alive(Duration::from_secs(10)))
}

async fn cancel(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
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

    let job_id = match Uuid::parse_str(&id) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest().json(serde_json::json!({"error": "invalid job id"}));
        }
    };

    match queue::cancel_job(&state, job_id).await {
        Ok(payload) => HttpResponse::Ok().json(payload),
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("job not found") {
                HttpResponse::NotFound().json(serde_json::json!({"error": msg}))
            } else {
                HttpResponse::InternalServerError().json(serde_json::json!({"error": msg}))
            }
        }
    }
}

async fn retry(
    state: web::Data<AppState>,
    req: HttpRequest,
    id: web::Path<String>,
    body: Option<web::Json<RetryPayload>>,
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

    let job_id = match Uuid::parse_str(&id) {
        Ok(v) => v,
        Err(_) => {
            return HttpResponse::BadRequest().json(serde_json::json!({"error": "invalid job id"}));
        }
    };

    let force = body.as_ref().map(|b| b.force).unwrap_or(false);
    match queue::retry_job(&state, job_id, force).await {
        Ok(new_job_id) => HttpResponse::Accepted().json(serde_json::json!({
            "job_id": new_job_id,
            "status": "pending",
            "retry_of": job_id
        })),
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("job not found") {
                HttpResponse::NotFound().json(serde_json::json!({"error": msg}))
            } else if msg.contains("already pending or running")
                || msg.contains("failed or cancelled")
            {
                HttpResponse::Conflict().json(serde_json::json!({"error": msg}))
            } else {
                HttpResponse::InternalServerError().json(serde_json::json!({"error": msg}))
            }
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct RetryPayload {
    force: bool,
}
