use anyhow::{Context, Result, bail};
use std::env;

#[derive(Clone)]
pub struct Config {
    pub mongo_uri: String,
    pub discord_client_id: String,
    pub discord_client_secret: String,
    pub discord_redirect_uri: String,
    pub jwt_secret: String,
    pub jwt_issuer: String,
    pub jwt_audience: String,
    pub oauth_state_secret: String,
    pub super_admin_discord_id: String,
    pub github_url: String,
    pub github_owner: String,
    pub github_repo: String,
    pub github_token: String,
    pub github_branch: String,
    pub rustfs_endpoint: String,
    pub rustfs_bucket: String,
    pub rustfs_access_key: String,
    pub rustfs_secret_key: String,
    pub rustfs_public_url_base: String,
    pub otel_exporter_otlp_endpoint: Option<String>,
    pub kofi_url: Option<String>,
    pub cookie_secure: bool,
    pub allowed_origin: String,
    pub session_idle_minutes: i64,
    pub session_absolute_hours: i64,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let mongo_uri = req("MONGO_URI")?;
        let discord_client_id = req("DISCORD_CLIENT_ID")?;
        let discord_client_secret = req("DISCORD_CLIENT_SECRET")?;
        let discord_redirect_uri = req("DISCORD_REDIRECT_URI")?;
        let jwt_secret = env::var("JWT_SECRET_CURRENT")
            .or_else(|_| env::var("JWT_SECRET"))
            .with_context(|| "missing required env var JWT_SECRET_CURRENT (or JWT_SECRET)")?;
        let oauth_state_secret = req("OAUTH_STATE_SECRET")?;
        let super_admin_discord_id = req("SUPER_ADMIN_DISCORD_ID")?;

        if jwt_secret.len() < 32 {
            bail!("JWT_SECRET must be at least 32 characters");
        }
        if oauth_state_secret.len() < 32 {
            bail!("OAUTH_STATE_SECRET must be at least 32 characters");
        }

        let github_url = req("GITHUB_URL")?;
        let (github_owner, github_repo) = parse_github_url(&github_url)?;
        let github_token = req("GITHUB_TOKEN")?;
        let github_branch = env::var("GITHUB_BRANCH").unwrap_or_else(|_| "main".to_string());

        let rustfs_endpoint = req("RUSTFS_ENDPOINT")?;
        let rustfs_bucket = req("RUSTFS_BUCKET")?;
        let rustfs_access_key = req("RUSTFS_ACCESS_KEY")?;
        let rustfs_secret_key = req("RUSTFS_SECRET_KEY")?;
        let rustfs_public_url_base = req("RUSTFS_PUBLIC_URL_BASE")?;

        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);

        Ok(Self {
            mongo_uri,
            discord_client_id,
            discord_client_secret,
            discord_redirect_uri,
            jwt_secret,
            jwt_issuer: env::var("JWT_ISSUER").unwrap_or_else(|_| "vtt-maps-site".to_string()),
            jwt_audience: env::var("JWT_AUDIENCE").unwrap_or_else(|_| "vtt-maps-web".to_string()),
            oauth_state_secret,
            super_admin_discord_id,
            github_url,
            github_owner,
            github_repo,
            github_token,
            github_branch,
            rustfs_endpoint,
            rustfs_bucket,
            rustfs_access_key,
            rustfs_secret_key,
            rustfs_public_url_base,
            otel_exporter_otlp_endpoint: env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok(),
            kofi_url: env::var("KOFI_URL").ok(),
            cookie_secure: env::var("COOKIE_SECURE")
                .map(|v| v == "true")
                .unwrap_or(false),
            allowed_origin: env::var("ALLOWED_ORIGIN")
                .unwrap_or_else(|_| "http://localhost:5173".to_string()),
            session_idle_minutes: env::var("SESSION_IDLE_MINUTES")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(60 * 12),
            session_absolute_hours: env::var("SESSION_ABSOLUTE_HOURS")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(24 * 7),
            port,
        })
    }
}

fn req(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("missing required env var {key}"))
}

fn parse_github_url(url: &str) -> Result<(String, String)> {
    let trimmed = url.trim().trim_end_matches(".git").trim_end_matches('/');
    let cleaned = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("git@github.com:"))
        .unwrap_or(trimmed);
    let mut parts = cleaned.splitn(2, '/');
    let owner = parts
        .next()
        .filter(|v| !v.is_empty())
        .context("GITHUB_URL missing owner segment")?;
    let repo = parts
        .next()
        .filter(|v| !v.is_empty())
        .context("GITHUB_URL missing repo segment")?;
    Ok((owner.to_string(), repo.to_string()))
}

#[cfg(test)]
mod tests {
    use super::parse_github_url;

    #[test]
    fn parses_https_github_url() {
        let (owner, repo) = parse_github_url("https://github.com/mbround18/vtt-maps").unwrap();
        assert_eq!(owner, "mbround18");
        assert_eq!(repo, "vtt-maps");
    }

    #[test]
    fn parses_https_github_url_with_git_suffix() {
        let (owner, repo) = parse_github_url("https://github.com/mbround18/vtt-maps.git").unwrap();
        assert_eq!(owner, "mbround18");
        assert_eq!(repo, "vtt-maps");
    }

    #[test]
    fn parses_ssh_style_github_url() {
        let (owner, repo) = parse_github_url("git@github.com:mbround18/vtt-maps.git").unwrap();
        assert_eq!(owner, "mbround18");
        assert_eq!(repo, "vtt-maps");
    }
}
