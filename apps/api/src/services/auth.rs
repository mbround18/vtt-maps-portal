use actix_web::{
    HttpRequest,
    cookie::{Cookie, SameSite, time::Duration as CookieDuration},
};
use anyhow::{Context, Result, bail};
use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use mongodb::bson::doc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    app::AppState,
    models::{OAuthState, Session, User},
    services::policy::{self, Permission},
};

pub const SESSION_COOKIE: &str = "vttmaps.session";
pub const OAUTH_STATE_COOKIE: &str = "vttmaps.oauth_state";
pub const CSRF_COOKIE: &str = "vttmaps.csrf";
pub const CSRF_HEADER: &str = "x-csrf-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub sid: String,
    pub jti: String,
    pub discord_id: String,
    pub username: String,
    pub role: String,
    pub nbf: i64,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Deserialize)]
pub struct DiscordTokenResponse {
    pub access_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscordUser {
    pub id: String,
    pub username: String,
    pub global_name: Option<String>,
    pub avatar: Option<String>,
    pub email: Option<String>,
}

impl DiscordUser {
    pub fn avatar_url(&self) -> Option<String> {
        self.avatar.as_ref().map(|avatar| {
            format!(
                "https://cdn.discordapp.com/avatars/{}/{}.png",
                self.id, avatar
            )
        })
    }

    pub fn display_name(&self) -> String {
        self.global_name
            .clone()
            .unwrap_or_else(|| self.username.clone())
    }
}

fn hash_with_secret(secret: &str, raw: &str) -> String {
    let mut h = Sha256::new();
    h.update(secret.as_bytes());
    h.update(b":");
    h.update(raw.as_bytes());
    hex::encode(h.finalize())
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn oauth_states_coll(state: &AppState) -> mongodb::Collection<OAuthState> {
    state.db.collection("oauth_states")
}

pub fn make_oauth_url(state: &AppState, token: &str) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer
        .append_pair("response_type", "code")
        .append_pair("client_id", &state.config.discord_client_id)
        .append_pair("redirect_uri", &state.config.discord_redirect_uri)
        .append_pair("scope", "identify email")
        .append_pair("state", token)
        .append_pair("prompt", "consent");
    format!(
        "https://discord.com/oauth2/authorize?{}",
        serializer.finish()
    )
}

pub fn make_state_cookie(state: &AppState, value: &str) -> Cookie<'static> {
    Cookie::build(OAUTH_STATE_COOKIE, value.to_string())
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::minutes(10))
        .finish()
}

pub fn clear_state_cookie(state: &AppState) -> Cookie<'static> {
    Cookie::build(OAUTH_STATE_COOKIE, "")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::seconds(0))
        .finish()
}

pub fn make_session_cookie(state: &AppState, token: &str) -> Cookie<'static> {
    Cookie::build(SESSION_COOKIE, token.to_string())
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::hours(12))
        .finish()
}

pub fn clear_session_cookie(state: &AppState) -> Cookie<'static> {
    Cookie::build(SESSION_COOKIE, "")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::seconds(0))
        .finish()
}

pub fn make_csrf_cookie(state: &AppState, token: &str) -> Cookie<'static> {
    Cookie::build(CSRF_COOKIE, token.to_string())
        .http_only(false)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::hours(12))
        .finish()
}

pub fn clear_csrf_cookie(state: &AppState) -> Cookie<'static> {
    Cookie::build(CSRF_COOKIE, "")
        .http_only(false)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(CookieDuration::seconds(0))
        .finish()
}

pub async fn issue_oauth_state(state: &AppState) -> Result<String> {
    let raw = random_token();
    let hashed = hash_with_secret(&state.config.oauth_state_secret, &raw);
    let expires = Utc::now() + Duration::minutes(10);

    oauth_states_coll(state)
        .insert_one(OAuthState {
            state_hash: hashed,
            expires_at: expires,
            used_at: None,
        })
        .await
        .context("failed to insert oauth state")?;

    Ok(raw)
}

pub async fn consume_oauth_state(state: &AppState, raw: &str) -> Result<()> {
    let hashed = hash_with_secret(&state.config.oauth_state_secret, raw);
    let now = Utc::now();

    let result = oauth_states_coll(state)
        .update_one(
            doc! {"state_hash": &hashed, "used_at": null, "expires_at": {"$gt": now}},
            doc! {"$set": {"used_at": now}},
        )
        .await
        .context("failed to consume oauth state")?;

    if result.modified_count == 0 {
        bail!("invalid oauth state")
    }

    Ok(())
}

pub async fn create_session_for_user(state: &AppState, user: &User) -> Result<(String, String)> {
    let sid = Uuid::new_v4();
    let jti = Uuid::new_v4().to_string();
    let csrf_raw = random_token();
    let csrf_hash = hash_with_secret(&state.config.jwt_secret, &csrf_raw);
    let expires = Utc::now() + Duration::hours(state.config.session_absolute_hours);

    let claims = SessionClaims {
        iss: state.config.jwt_issuer.clone(),
        aud: state.config.jwt_audience.clone(),
        sub: user.id.to_string(),
        sid: sid.to_string(),
        jti: jti.clone(),
        discord_id: user.discord_id.clone(),
        username: user.username.clone(),
        role: user.role.clone(),
        iat: Utc::now().timestamp(),
        nbf: Utc::now().timestamp(),
        exp: expires.timestamp(),
    };

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .context("failed to sign jwt")?;

    state
        .sessions_coll()
        .insert_one(Session {
            id: sid,
            user_id: user.id,
            jwt_id: jti,
            csrf_token_hash: csrf_hash,
            created_at: Utc::now(),
            expires_at: expires,
            last_seen_at: None,
            revoked_at: None,
            revoked_reason: None,
        })
        .await
        .context("failed to insert auth session")?;

    Ok((token, csrf_raw))
}

pub fn verify_jwt(state: &AppState, token: &str) -> Result<SessionClaims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[state.config.jwt_audience.as_str()]);
    validation.set_issuer(&[state.config.jwt_issuer.as_str()]);
    validation.validate_exp = true;
    validation.validate_nbf = true;

    let data = decode::<SessionClaims>(
        token,
        &DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        &validation,
    )
    .context("failed to verify jwt")?;

    Ok(data.claims)
}

pub async fn claims_from_request(req: &HttpRequest, state: &AppState) -> Result<SessionClaims> {
    let token = req
        .cookie(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or_else(|| anyhow::anyhow!("missing session cookie"))?;

    let claims = verify_jwt(state, &token)?;

    let session_id = Uuid::parse_str(&claims.sid).context("invalid session id in token")?;
    let session = state
        .sessions_coll()
        .find_one(doc! {"_id": session_id})
        .await
        .context("failed to read auth session")?
        .ok_or_else(|| anyhow::anyhow!("session not found"))?;

    if session.jwt_id != claims.jti {
        bail!("session jwt mismatch")
    }
    if session.revoked_at.is_some() {
        bail!("session revoked")
    }
    let now = Utc::now();
    let absolute_expiry = session.created_at + Duration::hours(state.config.session_absolute_hours);
    if session.expires_at <= now || absolute_expiry <= now {
        let _ = state
            .sessions_coll()
            .update_one(
                doc! {"_id": session.id},
                doc! {"$set": {"revoked_at": now, "revoked_reason": "absolute_timeout"}},
            )
            .await;
        bail!("session expired")
    }

    let idle_anchor = session.last_seen_at.unwrap_or(session.created_at);
    if idle_anchor + Duration::minutes(state.config.session_idle_minutes) <= now {
        let _ = state
            .sessions_coll()
            .update_one(
                doc! {"_id": session.id},
                doc! {"$set": {"revoked_at": now, "revoked_reason": "idle_timeout"}},
            )
            .await;
        bail!("session idle timeout")
    }

    let _ = state
        .sessions_coll()
        .update_one(
            doc! {"_id": session.id},
            doc! {"$set": {"last_seen_at": now}},
        )
        .await;

    Ok(claims)
}

pub async fn require_csrf(
    req: &HttpRequest,
    state: &AppState,
    claims: &SessionClaims,
) -> Result<()> {
    let header_token = req
        .headers()
        .get(CSRF_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(ToString::to_string)
        .ok_or_else(|| anyhow::anyhow!("missing csrf header"))?;

    let cookie_token = req
        .cookie(CSRF_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or_else(|| anyhow::anyhow!("missing csrf cookie"))?;

    if header_token != cookie_token {
        bail!("csrf token mismatch")
    }

    let session_id = Uuid::parse_str(&claims.sid).context("invalid session id")?;
    let expected_hash = hash_with_secret(&state.config.jwt_secret, &header_token);

    let session = state
        .sessions_coll()
        .find_one(doc! {"_id": session_id})
        .await
        .context("failed to query csrf hash")?
        .ok_or_else(|| anyhow::anyhow!("session not found for csrf"))?;

    if expected_hash != session.csrf_token_hash {
        bail!("csrf validation failed")
    }

    Ok(())
}

pub async fn revoke_session(state: &AppState, claims: &SessionClaims, reason: &str) -> Result<()> {
    let sid = Uuid::parse_str(&claims.sid).context("invalid session id")?;
    state
        .sessions_coll()
        .update_one(
            doc! {"_id": sid},
            doc! {"$set": {"revoked_at": Utc::now(), "revoked_reason": reason}},
        )
        .await
        .context("failed to revoke session")?;
    Ok(())
}

pub async fn exchange_code_for_token(state: &AppState, code: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let response = client
        .post("https://discord.com/api/oauth2/token")
        .form(&[
            ("client_id", state.config.discord_client_id.as_str()),
            ("client_secret", state.config.discord_client_secret.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", state.config.discord_redirect_uri.as_str()),
        ])
        .send()
        .await
        .context("discord token request failed")?
        .error_for_status()
        .context("discord token request returned non-success")?;

    let body = response
        .json::<DiscordTokenResponse>()
        .await
        .context("failed to parse discord token response")?;

    Ok(body.access_token)
}

pub async fn fetch_discord_user(access_token: &str) -> Result<DiscordUser> {
    let client = reqwest::Client::new();
    client
        .get("https://discord.com/api/users/@me")
        .bearer_auth(access_token)
        .send()
        .await
        .context("discord user request failed")?
        .error_for_status()
        .context("discord user request returned non-success")?
        .json::<DiscordUser>()
        .await
        .context("failed to parse discord user response")
}

/// Only the configured super-admin discord id is force-assigned the admin
/// role. Everyone else keeps whatever role is already stored for them (or
/// defaults to "user" on first login) -- admin-assigned roles are never
/// silently reverted on subsequent logins.
pub fn resolve_role(state: &AppState, discord_id: &str, existing_role: Option<&str>) -> String {
    if discord_id == state.config.super_admin_discord_id {
        return "admin".to_string();
    }
    existing_role.unwrap_or("user").to_string()
}

pub async fn find_user_by_id(state: &AppState, id: Uuid) -> Result<Option<User>> {
    state
        .users_coll()
        .find_one(doc! {"_id": id})
        .await
        .context("failed to query user")
}

pub async fn require_authenticated(req: &HttpRequest, state: &AppState) -> Result<SessionClaims> {
    claims_from_request(req, state)
        .await
        .context("unauthorized")
}

pub async fn require_admin(req: &HttpRequest, state: &AppState) -> Result<SessionClaims> {
    let claims = claims_from_request(req, state)
        .await
        .context("unauthorized")?;
    policy::authorize(&claims.role, Permission::AdminRead)?;
    Ok(claims)
}

/// Super admin is not a stored role -- it's the single account whose
/// discord id matches the configured `SUPER_ADMIN_DISCORD_ID` (see
/// `resolve_role`). Regular admins (manually promoted via
/// `/admin/users/{id}/role`) do not qualify.
pub fn is_super_admin(super_admin_discord_id: &str, claims: &SessionClaims) -> bool {
    claims.role == "admin" && claims.discord_id == super_admin_discord_id
}

pub async fn require_super_admin(req: &HttpRequest, state: &AppState) -> Result<SessionClaims> {
    let claims = require_admin(req, state).await?;
    if !is_super_admin(&state.config.super_admin_discord_id, &claims) {
        bail!("forbidden");
    }
    Ok(claims)
}

#[cfg(test)]
mod super_admin_tests {
    use super::{SessionClaims, is_super_admin};

    fn claims(role: &str, discord_id: &str) -> SessionClaims {
        SessionClaims {
            iss: "vtt-maps".into(),
            aud: "vtt-maps".into(),
            sub: "user-1".into(),
            sid: "sess-1".into(),
            jti: "jti-1".into(),
            discord_id: discord_id.into(),
            username: "tester".into(),
            role: role.into(),
            nbf: 0,
            exp: 0,
            iat: 0,
        }
    }

    #[test]
    fn only_the_configured_discord_id_with_admin_role_is_super_admin() {
        assert!(is_super_admin("111", &claims("admin", "111")));
        // Manually-promoted admins whose discord id isn't the configured
        // super admin id do not qualify.
        assert!(!is_super_admin("111", &claims("admin", "222")));
        // Non-admin role never qualifies, even with a matching discord id.
        assert!(!is_super_admin("111", &claims("user", "111")));
        assert!(!is_super_admin("111", &claims("contributor", "111")));
    }
}

pub async fn upsert_user_from_discord(state: &AppState, profile: &DiscordUser) -> Result<User> {
    let username = profile.display_name();
    let avatar = profile.avatar_url();
    let coll = state.users_coll();

    let existing = coll
        .find_one(doc! {"discord_id": &profile.id})
        .await
        .context("failed to query user")?;

    let role = resolve_role(
        state,
        &profile.id,
        existing.as_ref().map(|u| u.role.as_str()),
    );

    if let Some(existing_user) = existing {
        coll.update_one(
            doc! {"_id": existing_user.id},
            doc! {"$set": {
                "username": &username,
                "avatar_url": avatar.clone(),
                "email": profile.email.clone(),
                "role": &role,
                "updated_at": Utc::now(),
            }},
        )
        .await
        .context("failed to update user")?;

        return coll
            .find_one(doc! {"_id": existing_user.id})
            .await
            .context("failed to reload updated user")?
            .context("user disappeared after update");
    }

    let now = Utc::now();
    let new_user = User {
        id: Uuid::new_v4(),
        discord_id: profile.id.clone(),
        username,
        avatar_url: avatar,
        email: profile.email.clone(),
        role,
        created_at: now,
        updated_at: now,
    };

    coll.insert_one(&new_user)
        .await
        .context("failed to insert user")?;

    Ok(new_user)
}
