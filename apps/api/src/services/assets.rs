use std::time::Duration as StdDuration;

use anyhow::{Context, Result, bail};
use aws_credential_types::Credentials;
use aws_sdk_s3::{
    Client as S3Client,
    config::{BehaviorVersion, Region},
    presigning::PresigningConfig,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Utc;
use image::imageops::FilterType;
use mongodb::bson::doc;
use serde::Deserialize;
use tracing::{info, warn};
use uuid::Uuid;
use webp::Encoder;

use crate::{
    app::AppState,
    models::{Map, SyncRun, SyncRunError},
};

fn maps_coll(state: &AppState) -> mongodb::Collection<Map> {
    state.db.collection("maps")
}

fn sync_runs_coll(state: &AppState) -> mongodb::Collection<SyncRun> {
    state.db.collection("sync_runs")
}

pub fn s3_client(state: &AppState) -> S3Client {
    let creds = Credentials::new(
        &state.config.rustfs_access_key,
        &state.config.rustfs_secret_key,
        None,
        None,
        "rustfs",
    );
    let cfg = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .endpoint_url(&state.config.rustfs_endpoint)
        .credentials_provider(creds)
        .force_path_style(true)
        .build();
    S3Client::from_conf(cfg)
}

/// Creates the configured RustFS bucket if it doesn't already exist, and
/// sets a public-read policy on it. Idempotent — safe to call on every
/// startup (server) or CLI invocation.
///
/// Public-read is required because `public_url_for_key` hands out direct
/// (non-presigned) URLs for map images (`image_url`/`thumb_url`) — only the
/// `.dd2vtt` source download goes through a presigned URL, since that one
/// stays permission-gated.
pub async fn ensure_bucket(state: &AppState) -> Result<()> {
    let client = s3_client(state);
    let bucket = &state.config.rustfs_bucket;

    match client.create_bucket().bucket(bucket).send().await {
        Ok(_) => {}
        Err(err) => {
            let already_exists = err
                .as_service_error()
                .map(|e| e.is_bucket_already_owned_by_you() || e.is_bucket_already_exists())
                .unwrap_or(false);
            if !already_exists {
                return Err(err)
                    .with_context(|| format!("failed to create rustfs bucket {bucket}"));
            }
        }
    }

    let policy = serde_json::json!({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": "*",
            "Action": ["s3:GetObject"],
            "Resource": [format!("arn:aws:s3:::{bucket}/*")]
        }]
    })
    .to_string();

    client
        .put_bucket_policy()
        .bucket(bucket)
        .policy(policy)
        .send()
        .await
        .with_context(|| format!("failed to set public-read policy on bucket {bucket}"))?;

    Ok(())
}

pub fn public_url_for_key(state: &AppState, key: &str) -> String {
    format!(
        "{}/{}/{}",
        state.config.rustfs_public_url_base.trim_end_matches('/'),
        state.config.rustfs_bucket,
        key
    )
}

async fn upload_bytes(
    state: &AppState,
    key: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<()> {
    let client = s3_client(state);
    client
        .put_object()
        .bucket(&state.config.rustfs_bucket)
        .key(key)
        .body(bytes.into())
        .content_type(content_type)
        .send()
        .await
        .with_context(|| format!("failed to upload object {key} to rustfs"))?;
    Ok(())
}

async fn download_bytes(state: &AppState, key: &str) -> Result<Vec<u8>> {
    let client = s3_client(state);
    let output = client
        .get_object()
        .bucket(&state.config.rustfs_bucket)
        .key(key)
        .send()
        .await
        .with_context(|| format!("failed to download object {key} from rustfs"))?;
    let bytes = output
        .body
        .collect()
        .await
        .context("failed to read rustfs object body")?
        .into_bytes()
        .to_vec();
    Ok(bytes)
}

pub async fn presigned_asset_url(state: &AppState, key: &str) -> Result<String> {
    let client = s3_client(state);
    let presigned = client
        .get_object()
        .bucket(&state.config.rustfs_bucket)
        .key(key)
        .presigned(
            PresigningConfig::expires_in(StdDuration::from_secs(300))
                .context("failed to build presigning config")?,
        )
        .await
        .context("failed to presign rustfs object")?;
    Ok(presigned.uri().to_string())
}

fn normalize_segment(value: &str) -> String {
    value
        .split(['-', '_', ' '])
        .filter(|s| !s.trim().is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => {
                    format!(
                        "{}{}",
                        first.to_ascii_uppercase(),
                        chars.as_str().to_ascii_lowercase()
                    )
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Ported as-is from the git-clone based sync: derives a display name and
/// tag list from a repo-relative map path, e.g.
/// "dungeons/dwarven-forge/dwarven-forge.dd2vtt".
pub fn derive_name_and_tags_from_path(rel: &str) -> (String, Vec<String>) {
    let parts: Vec<&str> = rel.split('/').collect();
    let stem = std::path::Path::new(rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("map");
    let display_name = normalize_segment(stem);

    let mut tags = Vec::new();
    for segment in parts.iter().take(parts.len().saturating_sub(1)) {
        let t = normalize_segment(segment);
        if !t.is_empty() && !tags.iter().any(|x: &String| x.eq_ignore_ascii_case(&t)) {
            tags.push(t);
        }
    }
    if !tags
        .iter()
        .any(|x: &String| x.eq_ignore_ascii_case(&display_name))
    {
        tags.push(display_name.clone());
    }
    (display_name, tags)
}

#[derive(Debug, Deserialize)]
struct GitTreeResponse {
    tree: Vec<GitTreeEntry>,
}

#[derive(Debug, Deserialize)]
struct GitTreeEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
}

async fn fetch_repo_tree(state: &AppState) -> Result<Vec<String>> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        state.config.github_owner, state.config.github_repo, state.config.github_branch
    );
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", state.config.github_token),
        )
        .header("User-Agent", "vtt-maps-site")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .context("github tree request failed")?
        .error_for_status()
        .context("github tree request returned non-success")?;

    let body = response
        .json::<GitTreeResponse>()
        .await
        .context("failed to parse github tree response")?;

    Ok(body
        .tree
        .into_iter()
        .filter(|entry| {
            entry.entry_type == "blob"
                && entry.path.starts_with("maps/")
                && entry.path.ends_with(".dd2vtt")
        })
        .map(|entry| entry.path)
        .collect())
}

async fn fetch_file_bytes(state: &AppState, path: &str) -> Result<Vec<u8>> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
        state.config.github_owner, state.config.github_repo, path, state.config.github_branch
    );
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", state.config.github_token),
        )
        .header("User-Agent", "vtt-maps-site")
        .header("Accept", "application/vnd.github.raw")
        .send()
        .await
        .context("github contents request failed")?
        .error_for_status()
        .context("github contents request returned non-success")?;

    let bytes = response
        .bytes()
        .await
        .context("failed to read github contents response body")?;
    Ok(bytes.to_vec())
}

/// Discovers new `.dd2vtt` files under `maps/` in the configured GitHub repo,
/// downloads and uploads them to RustFS, inserts pending `maps` documents,
/// and enqueues `extract_image` for each newly discovered map. Writes a
/// `sync_runs` document describing the outcome.
pub async fn sync_maps(state: &AppState) -> Result<Vec<Uuid>> {
    let run_id = Uuid::new_v4();
    let started_at = Utc::now();
    sync_runs_coll(state)
        .insert_one(SyncRun {
            id: run_id,
            started_at,
            finished_at: None,
            status: "running".to_string(),
            maps_found: 0,
            maps_new: 0,
            errors: vec![],
        })
        .await
        .context("failed to write sync_runs start doc")?;

    let mut errors = Vec::new();
    let mut new_map_ids = Vec::new();

    let tree_result = fetch_repo_tree(state).await;
    let paths = match tree_result {
        Ok(paths) => paths,
        Err(err) => {
            let _ = sync_runs_coll(state)
                .update_one(
                    doc! {"_id": run_id},
                    doc! {"$set": {
                        "status": "failed",
                        "finished_at": Utc::now(),
                        "errors": [{"path": "", "message": err.to_string()}],
                    }},
                )
                .await;
            return Err(err);
        }
    };
    let maps_found = paths.len() as i32;

    for path in paths {
        let rel = path.trim_start_matches("maps/").to_string();
        let existing = maps_coll(state)
            .find_one(doc! {"path": &rel})
            .await
            .context("failed to query existing map by path")?;
        if existing.is_some() {
            continue;
        }

        match sync_one_map(state, &path, &rel).await {
            Ok(map_id) => new_map_ids.push(map_id),
            Err(err) => {
                warn!("failed to sync map {path}: {err:#}");
                errors.push(SyncRunError {
                    path: path.clone(),
                    message: err.to_string(),
                });
            }
        }
    }

    let status = if errors.is_empty() {
        "completed"
    } else {
        "completed_with_errors"
    };
    let errors_bson: Vec<mongodb::bson::Bson> = errors
        .iter()
        .map(|e| mongodb::bson::to_bson(e).unwrap_or(mongodb::bson::Bson::Null))
        .collect();
    let _ = sync_runs_coll(state)
        .update_one(
            doc! {"_id": run_id},
            doc! {"$set": {
                "status": status,
                "finished_at": Utc::now(),
                "maps_found": maps_found,
                "maps_new": new_map_ids.len() as i32,
                "errors": errors_bson,
            }},
        )
        .await;

    info!(
        "sync_maps run {} completed: found={} new={} errors={}",
        run_id,
        maps_found,
        new_map_ids.len(),
        errors.len()
    );

    Ok(new_map_ids)
}

async fn sync_one_map(state: &AppState, github_path: &str, rel: &str) -> Result<Uuid> {
    let bytes = fetch_file_bytes(state, github_path).await?;
    ingest_map_bytes(state, rel, bytes).await
}

/// Uploads a `.dd2vtt`'s raw bytes to RustFS and inserts a pending `maps`
/// document for it. Shared by the GitHub-API sync path and the local-clone
/// preload path (`preload_from_directory`).
async fn ingest_map_bytes(state: &AppState, rel: &str, bytes: Vec<u8>) -> Result<Uuid> {
    let map_id = Uuid::new_v4();
    let source_key = format!("maps/{map_id}/source.dd2vtt");
    upload_bytes(state, &source_key, bytes, "application/json").await?;

    let (name, tags) = derive_name_and_tags_from_path(rel);
    let now = Utc::now();
    maps_coll(state)
        .insert_one(Map {
            id: map_id,
            path: rel.to_string(),
            name,
            tags,
            about_md: String::new(),
            poi: serde_json::json!([]),
            source_key,
            image_key: None,
            thumb_key: None,
            width: None,
            height: None,
            status: "pending".to_string(),
            error: None,
            discovered_at: now,
            updated_at: now,
        })
        .await
        .context("failed to insert map document")?;

    Ok(map_id)
}

#[derive(Debug)]
pub struct PreloadSummary {
    pub run_id: Uuid,
    pub maps_found: i32,
    pub maps_new: usize,
    pub errors: usize,
}

/// Walks `maps_dir` (expected to be the `maps/` directory of a local repo
/// checkout, e.g. from a `git clone` into a temp dir) for `.dd2vtt` files,
/// ingests any not already known, and synchronously extracts images for all
/// newly discovered maps. Intended for one-shot batch use (the `mapper
/// preload` CLI), unlike `sync_maps` which enqueues `extract_image` as a
/// background job for the long-running server.
pub async fn preload_from_directory(
    state: &AppState,
    maps_dir: &std::path::Path,
) -> Result<PreloadSummary> {
    let run_id = Uuid::new_v4();
    let started_at = Utc::now();
    sync_runs_coll(state)
        .insert_one(SyncRun {
            id: run_id,
            started_at,
            finished_at: None,
            status: "running".to_string(),
            maps_found: 0,
            maps_new: 0,
            errors: vec![],
        })
        .await
        .context("failed to write sync_runs start doc")?;

    let mut errors = Vec::new();
    let mut new_map_ids = Vec::new();
    let mut maps_found = 0i32;

    for entry in walkdir::WalkDir::new(maps_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("dd2vtt") {
            continue;
        }
        maps_found += 1;

        let rel = path
            .strip_prefix(maps_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        let existing = match maps_coll(state).find_one(doc! {"path": &rel}).await {
            Ok(v) => v,
            Err(err) => {
                errors.push(SyncRunError {
                    path: rel.clone(),
                    message: format!("failed to query existing map: {err}"),
                });
                continue;
            }
        };
        if existing.is_some() {
            continue;
        }

        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(err) => {
                errors.push(SyncRunError {
                    path: rel.clone(),
                    message: format!("failed to read file: {err}"),
                });
                continue;
            }
        };

        match ingest_map_bytes(state, &rel, bytes).await {
            Ok(map_id) => new_map_ids.push(map_id),
            Err(err) => {
                warn!("failed to ingest map {rel}: {err:#}");
                errors.push(SyncRunError {
                    path: rel,
                    message: err.to_string(),
                });
            }
        }
    }

    for map_id in &new_map_ids {
        if let Err(err) = extract_image(state, *map_id).await {
            warn!("extract_image failed for {map_id}: {err:#}");
            errors.push(SyncRunError {
                path: map_id.to_string(),
                message: err.to_string(),
            });
        }
    }

    let status = if errors.is_empty() {
        "completed"
    } else {
        "completed_with_errors"
    };
    let errors_bson: Vec<mongodb::bson::Bson> = errors
        .iter()
        .map(|e| mongodb::bson::to_bson(e).unwrap_or(mongodb::bson::Bson::Null))
        .collect();
    let _ = sync_runs_coll(state)
        .update_one(
            doc! {"_id": run_id},
            doc! {"$set": {
                "status": status,
                "finished_at": Utc::now(),
                "maps_found": maps_found,
                "maps_new": new_map_ids.len() as i32,
                "errors": errors_bson,
            }},
        )
        .await;

    info!(
        "preload run {} completed: found={} new={} errors={}",
        run_id,
        maps_found,
        new_map_ids.len(),
        errors.len()
    );

    Ok(PreloadSummary {
        run_id,
        maps_found,
        maps_new: new_map_ids.len(),
        errors: errors.len(),
    })
}

pub async fn find_map_by_id(state: &AppState, id: &str) -> Result<Option<Map>> {
    if let Ok(uuid) = Uuid::parse_str(id)
        && let Some(map) = maps_coll(state)
            .find_one(doc! {"_id": uuid})
            .await
            .context("failed to query map by id")?
    {
        return Ok(Some(map));
    }
    maps_coll(state)
        .find_one(doc! {"path": id})
        .await
        .context("failed to query map by path")
}

async fn mark_map_error(state: &AppState, map_id: Uuid, message: &str) {
    let _ = maps_coll(state)
        .update_one(
            doc! {"_id": map_id},
            doc! {"$set": {"status": "error", "error": message, "updated_at": Utc::now()}},
        )
        .await;
}

/// Downloads a map's source `.dd2vtt`, extracts the inline base64 image,
/// encodes full-size and 1/8-scale webp thumbnails, uploads them to RustFS,
/// and marks the map ready.
pub async fn extract_image(state: &AppState, map_id: Uuid) -> Result<()> {
    let _ = maps_coll(state)
        .update_one(
            doc! {"_id": map_id},
            doc! {"$set": {"status": "processing", "updated_at": Utc::now()}},
        )
        .await;

    let map = maps_coll(state)
        .find_one(doc! {"_id": map_id})
        .await
        .context("failed to load map for image extraction")?
        .ok_or_else(|| anyhow::anyhow!("map not found"))?;

    let source_bytes = download_bytes(state, &map.source_key).await?;
    let json: serde_json::Value = match serde_json::from_slice(&source_bytes) {
        Ok(v) => v,
        Err(err) => {
            let msg = format!("failed to parse dd2vtt json: {err}");
            mark_map_error(state, map_id, &msg).await;
            bail!(msg)
        }
    };

    let Some(image_field) = json.get("image").and_then(|v| v.as_str()) else {
        let msg = "dd2vtt has no inline image field".to_string();
        mark_map_error(state, map_id, &msg).await;
        bail!(msg)
    };

    // Universal VTT / dd2vtt files store the embedded image either as a
    // full `data:image/...;base64,<payload>` URI, or (as most real-world
    // exports do, including the reference vtt-maps repo) as a bare base64
    // string with no data-URI wrapper at all. Accept both.
    let payload = match image_field.starts_with("data:image/") {
        true => match image_field.split_once(',') {
            Some((_, payload)) => payload,
            None => {
                let msg = "dd2vtt image field is a data URI with no payload".to_string();
                mark_map_error(state, map_id, &msg).await;
                bail!(msg)
            }
        },
        false => image_field,
    };

    let decoded = match BASE64.decode(payload) {
        Ok(v) => v,
        Err(err) => {
            let msg = format!("failed to decode base64 image: {err}");
            mark_map_error(state, map_id, &msg).await;
            bail!(msg)
        }
    };

    let image = match image::load_from_memory(&decoded) {
        Ok(v) => v,
        Err(err) => {
            let msg = format!("failed to decode embedded image: {err}");
            mark_map_error(state, map_id, &msg).await;
            bail!(msg)
        }
    };

    let width = image.width();
    let height = image.height();

    let full_rgba = image.to_rgba8();
    let full_webp = Encoder::from_rgba(&full_rgba, width, height)
        .encode(80.0)
        .to_vec();

    let thumb_w = (width / 8).max(1);
    let thumb_h = (height / 8).max(1);
    let thumb_image = image.resize(thumb_w, thumb_h, FilterType::Lanczos3);
    let thumb_rgba = thumb_image.to_rgba8();
    let thumb_webp = Encoder::from_rgba(&thumb_rgba, thumb_rgba.width(), thumb_rgba.height())
        .encode(80.0)
        .to_vec();

    let image_key = format!("maps/{map_id}/full.webp");
    let thumb_key = format!("maps/{map_id}/thumb.webp");
    upload_bytes(state, &image_key, full_webp, "image/webp").await?;
    upload_bytes(state, &thumb_key, thumb_webp, "image/webp").await?;

    maps_coll(state)
        .update_one(
            doc! {"_id": map_id},
            doc! {"$set": {
                "image_key": &image_key,
                "thumb_key": &thumb_key,
                "width": width as i64,
                "height": height as i64,
                "status": "ready",
                "error": mongodb::bson::Bson::Null,
                "updated_at": Utc::now(),
            }},
        )
        .await
        .context("failed to mark map ready")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::derive_name_and_tags_from_path;

    #[test]
    fn derives_display_name_and_tags_from_nested_path() {
        let (name, tags) =
            derive_name_and_tags_from_path("dungeons/dwarven-forge/dwarven_ruins.dd2vtt");
        assert_eq!(name, "Dwarven Ruins");
        assert!(tags.iter().any(|t| t == "Dungeons"));
        assert!(tags.iter().any(|t| t == "Dwarven Forge"));
        assert!(tags.iter().any(|t| t == "Dwarven Ruins"));
    }

    #[test]
    fn derives_name_from_flat_path() {
        let (name, tags) = derive_name_and_tags_from_path("simple-beach.dd2vtt");
        assert_eq!(name, "Simple Beach");
        assert_eq!(tags, vec!["Simple Beach".to_string()]);
    }
}
