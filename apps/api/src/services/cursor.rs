use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use uuid::Uuid;

/// Opaque pagination cursor -- `base64(timestamp_ms|uuid)` -- for paging
/// through Mongo collections sorted by `(created_at desc, _id)`.
pub fn encode_timestamp_id_cursor(at: DateTime<Utc>, id: Uuid) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}|{}", at.timestamp_millis(), id))
}

pub fn decode_timestamp_id_cursor(input: &str) -> Option<(DateTime<Utc>, Uuid)> {
    let decoded = URL_SAFE_NO_PAD.decode(input).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let mut parts = text.split('|');
    let ms = parts.next()?.parse::<i64>().ok()?;
    let id = Uuid::parse_str(parts.next()?).ok()?;
    let at = DateTime::<Utc>::from_timestamp_millis(ms)?;
    Some((at, id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_timestamp_and_id() {
        let at = Utc::now();
        let id = Uuid::new_v4();
        let cursor = encode_timestamp_id_cursor(at, id);
        let (decoded_at, decoded_id) = decode_timestamp_id_cursor(&cursor).expect("decodes");
        assert_eq!(decoded_at.timestamp_millis(), at.timestamp_millis());
        assert_eq!(decoded_id, id);
    }

    #[test]
    fn rejects_garbage_input() {
        assert!(decode_timestamp_id_cursor("not-a-valid-cursor").is_none());
    }
}
