use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// `uuid::Uuid` fields must always use this (or [`opt_uuid_as_binary`]) via
/// `#[serde(with = ...)]`. Without it, serde's default `Uuid` impl (from the
/// `uuid` crate, not `bson`) writes a BSON generic-binary (subtype 0) value,
/// while `doc! {"_id": some_uuid}` queries built via `Uuid`'s `Into<Bson>`
/// impl produce a standard UUID binary (subtype 4) — same bytes, different
/// subtype, so MongoDB treats them as unequal and lookups silently miss.
pub use bson::serde_helpers::uuid_1_as_binary;

/// `chrono::DateTime<Utc>` fields must always use this (or
/// [`opt_chrono_datetime_as_bson_datetime`]). Without it, serde's default
/// `DateTime` impl (from the `chrono` crate) writes an RFC 3339 string,
/// while `doc! {"updated_at": Utc::now()}` writes a native BSON Date via
/// chrono's `Into<Bson>` impl — two different BSON types for the same
/// field, so reading a document back through the typed struct fails with
/// "invalid type: map, expected an RFC 3339 ... string" the moment any
/// code updates the field via a raw `doc!` (which is most writes here).
pub use bson::serde_helpers::chrono_datetime_as_bson_datetime;
pub use bson::serde_helpers::chrono_datetime_as_bson_datetime_optional as opt_chrono_datetime_as_bson_datetime;

/// `Option<Uuid>` counterpart to [`uuid_1_as_binary`] — that helper's
/// `serialize`/`deserialize` functions only accept a bare `Uuid`, so
/// optional id fields need this thin wrapper instead.
pub mod opt_uuid_as_binary {
    use serde::{Deserialize, Deserializer, Serializer};
    use uuid::Uuid;

    pub fn serialize<S: Serializer>(val: &Option<Uuid>, serializer: S) -> Result<S::Ok, S::Error> {
        match val {
            Some(uuid) => super::uuid_1_as_binary::serialize(uuid, serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Uuid>, D::Error> {
        #[derive(Deserialize)]
        struct Wrapper(#[serde(with = "super::uuid_1_as_binary")] Uuid);
        Ok(Option::<Wrapper>::deserialize(deserializer)?.map(|Wrapper(uuid)| uuid))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    #[serde(rename = "_id", with = "uuid_1_as_binary")]
    pub id: Uuid,
    pub discord_id: String,
    pub username: String,
    pub avatar_url: Option<String>,
    pub email: Option<String>,
    pub role: String,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    #[serde(rename = "_id", with = "uuid_1_as_binary")]
    pub id: Uuid,
    #[serde(with = "uuid_1_as_binary")]
    pub user_id: Uuid,
    pub jwt_id: String,
    pub csrf_token_hash: String,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub expires_at: DateTime<Utc>,
    #[serde(with = "opt_chrono_datetime_as_bson_datetime")]
    pub last_seen_at: Option<DateTime<Utc>>,
    #[serde(with = "opt_chrono_datetime_as_bson_datetime")]
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthState {
    pub state_hash: String,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub expires_at: DateTime<Utc>,
    #[serde(with = "opt_chrono_datetime_as_bson_datetime")]
    pub used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Map {
    #[serde(rename = "_id", with = "uuid_1_as_binary")]
    pub id: Uuid,
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub about_md: String,
    #[serde(default = "default_poi")]
    pub poi: serde_json::Value,
    pub source_key: String,
    pub image_key: Option<String>,
    pub thumb_key: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub status: String,
    pub error: Option<String>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub discovered_at: DateTime<Utc>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub updated_at: DateTime<Utc>,
}

fn default_poi() -> serde_json::Value {
    serde_json::json!([])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapView {
    #[serde(
        rename = "_id",
        with = "opt_uuid_as_binary",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<Uuid>,
    #[serde(with = "uuid_1_as_binary")]
    pub map_id: Uuid,
    #[serde(with = "opt_uuid_as_binary")]
    pub user_id: Option<Uuid>,
    pub session_id: String,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "opt_chrono_datetime_as_bson_datetime")]
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapDownload {
    #[serde(
        rename = "_id",
        with = "opt_uuid_as_binary",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<Uuid>,
    #[serde(with = "uuid_1_as_binary")]
    pub map_id: Uuid,
    #[serde(with = "opt_uuid_as_binary")]
    pub user_id: Option<Uuid>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub downloaded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapVote {
    #[serde(
        rename = "_id",
        with = "opt_uuid_as_binary",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<Uuid>,
    #[serde(with = "uuid_1_as_binary")]
    pub map_id: Uuid,
    #[serde(with = "uuid_1_as_binary")]
    pub user_id: Uuid,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobProgress {
    pub processed: i32,
    pub total: i32,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    #[serde(rename = "_id", with = "uuid_1_as_binary")]
    pub id: Uuid,
    pub job_type: String,
    pub status: String,
    pub payload: serde_json::Value,
    pub progress: Option<JobProgress>,
    pub cancel_requested: bool,
    pub attempts: i32,
    pub max_attempts: i32,
    pub error: Option<String>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub updated_at: DateTime<Utc>,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub available_at: DateTime<Utc>,
    #[serde(with = "opt_chrono_datetime_as_bson_datetime")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(with = "opt_chrono_datetime_as_bson_datetime")]
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRunError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRun {
    #[serde(rename = "_id", with = "uuid_1_as_binary")]
    pub id: Uuid,
    #[serde(with = "chrono_datetime_as_bson_datetime")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "opt_chrono_datetime_as_bson_datetime")]
    pub finished_at: Option<DateTime<Utc>>,
    pub status: String,
    pub maps_found: i32,
    pub maps_new: i32,
    #[serde(default)]
    pub errors: Vec<SyncRunError>,
}
