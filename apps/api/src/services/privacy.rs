use actix_web::HttpRequest;

pub const COOKIE_CONSENT_HEADER: &str = "x-cookie-consent";
pub const COOKIE_CONSENT_COOKIE: &str = "vttmaps_cookie_consent";

fn consent_value(req: &HttpRequest) -> Option<String> {
    req.headers()
        .get(COOKIE_CONSENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(ToString::to_string)
        .or_else(|| {
            req.cookie(COOKIE_CONSENT_COOKIE)
                .map(|c| c.value().to_string())
        })
}

pub fn analytics_consent_granted(req: &HttpRequest) -> bool {
    matches!(
        consent_value(req)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "granted" | "true" | "yes" | "1"
    )
}
