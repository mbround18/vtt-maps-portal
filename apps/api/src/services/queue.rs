use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::Utc;
use mongodb::{
    bson::doc,
    options::{FindOneAndUpdateOptions, ReturnDocument},
};
use tokio::time::sleep;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    app::AppState,
    models::{Job, JobProgress},
    services::assets,
};

const MAX_ATTEMPTS: i32 = 5;
const TRANSIENT_RETRY_BASE_SECS: i64 = 10;

fn jobs_coll(state: &AppState) -> mongodb::Collection<Job> {
    state.db.collection("jobs")
}

fn classify_error(err: &anyhow::Error) -> ErrorClass {
    let msg = err.to_string().to_lowercase();
    if msg.contains("timeout")
        || msg.contains("temporar")
        || msg.contains("network")
        || msg.contains("connection")
        || msg.contains("rate limit")
    {
        ErrorClass::Transient
    } else {
        ErrorClass::Permanent
    }
}

#[derive(Debug, Clone, Copy)]
enum ErrorClass {
    Transient,
    Permanent,
}

/// Enqueues a job. For the two singleton job types (`sync_maps`), refuses to
/// double-enqueue while one is already pending or running.
pub async fn enqueue_job(
    state: &AppState,
    job_type: &str,
    payload: serde_json::Value,
) -> Result<Uuid> {
    if job_type == "sync_maps" {
        let existing = jobs_coll(state)
            .find_one(doc! {
                "job_type": job_type,
                "status": {"$in": ["pending", "running"]},
            })
            .await
            .context("failed to check for existing sync_maps job")?;
        if existing.is_some() {
            bail!("{job_type} already pending or running")
        }
    }

    let id = Uuid::new_v4();
    let now = Utc::now();
    jobs_coll(state)
        .insert_one(Job {
            id,
            job_type: job_type.to_string(),
            status: "pending".to_string(),
            payload,
            progress: None,
            cancel_requested: false,
            attempts: 0,
            max_attempts: MAX_ATTEMPTS,
            error: None,
            created_at: now,
            updated_at: now,
            available_at: now,
            started_at: None,
            completed_at: None,
        })
        .await
        .context("failed to insert job")?;

    Ok(id)
}

pub async fn cancel_job(state: &AppState, job_id: Uuid) -> Result<serde_json::Value> {
    let job = jobs_coll(state)
        .find_one(doc! {"_id": job_id})
        .await
        .context("failed to query job")?
        .ok_or_else(|| anyhow::anyhow!("job not found"))?;

    if matches!(job.status.as_str(), "completed" | "failed" | "cancelled") {
        return Ok(serde_json::json!({
            "id": job_id,
            "job_type": job.job_type,
            "status": job.status,
            "cancelled": false
        }));
    }

    let next_status = if job.status == "running" {
        "cancel_requested"
    } else {
        "cancelled"
    };

    jobs_coll(state)
        .update_one(
            doc! {"_id": job_id},
            doc! {"$set": {
                "cancel_requested": true,
                "status": next_status,
                "completed_at": if next_status == "cancelled" { mongodb::bson::Bson::DateTime(Utc::now().into()) } else { mongodb::bson::Bson::Null },
                "error": "cancelled by admin",
            }},
        )
        .await
        .context("failed to update cancellation status")?;

    Ok(serde_json::json!({
        "id": job_id,
        "job_type": job.job_type,
        "status": next_status,
        "cancelled": true
    }))
}

pub async fn retry_job(state: &AppState, job_id: Uuid, _force: bool) -> Result<Uuid> {
    let job = jobs_coll(state)
        .find_one(doc! {"_id": job_id})
        .await
        .context("failed to query retry job")?
        .ok_or_else(|| anyhow::anyhow!("job not found"))?;

    if !matches!(job.status.as_str(), "failed" | "cancelled") {
        bail!("job must be failed or cancelled before retry")
    }

    enqueue_job(state, &job.job_type, job.payload).await
}

async fn set_progress(state: &AppState, job_id: Uuid, progress: &JobProgress) {
    let value = mongodb::bson::to_bson(progress).unwrap_or(mongodb::bson::Bson::Null);
    let _ = jobs_coll(state)
        .update_one(doc! {"_id": job_id}, doc! {"$set": {"progress": value}})
        .await;
}

async fn is_cancelled(state: &AppState, job_id: Uuid) -> bool {
    jobs_coll(state)
        .find_one(doc! {"_id": job_id})
        .await
        .ok()
        .flatten()
        .map(|j| j.cancel_requested)
        .unwrap_or(false)
}

pub async fn start_worker(state: actix_web::web::Data<AppState>) {
    tokio::spawn(async move {
        loop {
            match next_job(&state).await {
                Ok(Some(job)) => {
                    if let Err(err) = process_job(&state, job).await {
                        error!("job processing failed: {err:#}");
                    }
                }
                Ok(None) => sleep(Duration::from_millis(300)).await,
                Err(err) => {
                    warn!("job worker fetch error: {err:#}");
                    sleep(Duration::from_millis(500)).await;
                }
            }
        }
    });
}

async fn next_job(state: &AppState) -> Result<Option<Job>> {
    let now = Utc::now();
    let options = FindOneAndUpdateOptions::builder()
        .sort(doc! {"created_at": 1})
        .return_document(ReturnDocument::After)
        .build();
    let job = jobs_coll(state)
        .find_one_and_update(
            doc! {"status": "pending", "available_at": {"$lte": now}},
            doc! {"$set": {"status": "running", "updated_at": now, "started_at": now}},
        )
        .with_options(options)
        .await
        .context("failed to pick queued job")?;
    Ok(job)
}

async fn process_job(state: &AppState, job: Job) -> Result<()> {
    set_progress(
        state,
        job.id,
        &JobProgress {
            processed: 0,
            total: 0,
            phase: "starting".to_string(),
        },
    )
    .await;

    let result: Result<()> = match job.job_type.as_str() {
        "sync_maps" => match assets::sync_maps(state).await {
            Ok(new_map_ids) => {
                for map_id in new_map_ids {
                    let _ = enqueue_job(
                        state,
                        "extract_image",
                        serde_json::json!({"map_id": map_id.to_string()}),
                    )
                    .await;
                }
                Ok(())
            }
            Err(err) => Err(err),
        },
        "extract_image" => {
            let map_id = job
                .payload
                .get("map_id")
                .and_then(|v| v.as_str())
                .and_then(|v| Uuid::parse_str(v).ok());
            match map_id {
                Some(map_id) => assets::extract_image(state, map_id).await,
                None => Err(anyhow::anyhow!("extract_image job missing map_id")),
            }
        }
        other => Err(anyhow::anyhow!("unknown job_type: {other}")),
    };

    let was_cancelled = is_cancelled(state, job.id).await;
    let now = Utc::now();

    if was_cancelled {
        let _ = jobs_coll(state)
            .update_one(
                doc! {"_id": job.id},
                doc! {"$set": {"status": "cancelled", "completed_at": now, "error": "cancelled by admin"}},
            )
            .await;
        warn!("job cancelled: {} ({})", job.id, job.job_type);
        return Ok(());
    }

    match result {
        Ok(_) => {
            let _ = jobs_coll(state)
                .update_one(
                    doc! {"_id": job.id},
                    doc! {"$set": {
                        "status": "completed",
                        "attempts": job.attempts + 1,
                        "completed_at": now,
                        "error": mongodb::bson::Bson::Null,
                    }},
                )
                .await;
            info!("job completed: {} ({})", job.id, job.job_type);
        }
        Err(err) => {
            let class = classify_error(&err);
            let attempts_done = job.attempts + 1;

            if matches!(class, ErrorClass::Transient) && attempts_done < job.max_attempts {
                let backoff = TRANSIENT_RETRY_BASE_SECS * i64::from(attempts_done.max(1));
                let _ = jobs_coll(state)
                    .update_one(
                        doc! {"_id": job.id},
                        doc! {"$set": {
                            "status": "pending",
                            "attempts": attempts_done,
                            "error": err.to_string(),
                            "available_at": now + chrono::Duration::seconds(backoff),
                            "updated_at": now,
                        }},
                    )
                    .await;
                warn!(
                    "job transient failure, scheduled retry: {} ({}) attempt {}/{}",
                    job.id, job.job_type, attempts_done, job.max_attempts
                );
            } else {
                let _ = jobs_coll(state)
                    .update_one(
                        doc! {"_id": job.id},
                        doc! {"$set": {
                            "status": "failed",
                            "attempts": attempts_done,
                            "completed_at": now,
                            "error": err.to_string(),
                        }},
                    )
                    .await;
                warn!("job failed: {} ({})", job.id, job.job_type);
            }
        }
    }

    Ok(())
}
