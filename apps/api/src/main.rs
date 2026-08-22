use api::{app, config, db, routes, services};

use actix_files::{Files, NamedFile};
use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer,
    dev::{ServiceRequest, ServiceResponse, fn_service},
    middleware::{DefaultHeaders, NormalizePath, TrailingSlash},
    web,
};
use app::AppState;
use config::Config;
use jsonwebtoken::crypto::rust_crypto::DEFAULT_PROVIDER;
use tracing::{error, info, warn};

async fn spa_index() -> actix_web::Result<NamedFile> {
    Ok(NamedFile::open_async("./apps/web/dist/index.html").await?)
}

fn is_api_path(path: &str) -> bool {
    path.starts_with("/api/")
}

fn should_spa_fallback(method: &actix_web::http::Method, path: &str) -> bool {
    (method == actix_web::http::Method::GET || method == actix_web::http::Method::HEAD)
        && !is_api_path(path)
}

async fn spa_or_api_404(req: HttpRequest) -> HttpResponse {
    if should_spa_fallback(req.method(), req.path()) {
        match spa_index().await {
            Ok(file) => file.into_response(&req),
            Err(_) => HttpResponse::InternalServerError()
                .json(serde_json::json!({"error": "spa index unavailable"})),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "not found"}))
    }
}

async fn files_fallback(req: ServiceRequest) -> Result<ServiceResponse, actix_web::Error> {
    let (req, _) = req.into_parts();
    if should_spa_fallback(req.method(), req.path()) {
        let file = NamedFile::open_async("./apps/web/dist/index.html").await?;
        let resp = file.into_response(&req);
        Ok(ServiceResponse::new(req, resp))
    } else {
        let resp = HttpResponse::NotFound().json(serde_json::json!({"error": "not found"}));
        Ok(ServiceResponse::new(req, resp))
    }
}

const SYNC_MAPS_INTERVAL_SECS: u64 = 24 * 60 * 60;

async fn start_nightly_sync_loop(state: web::Data<AppState>) {
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs(SYNC_MAPS_INTERVAL_SECS));
        // First tick fires immediately; skip it so we don't double-sync right at boot
        // if an admin already triggered one.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(err) =
                services::queue::enqueue_job(&state, "sync_maps", serde_json::json!({})).await
            {
                warn!("nightly sync_maps enqueue skipped: {err:#}");
            }
        }
    });
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();

    let cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("config error: {err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = app::telemetry::init_tracing(cfg.otel_exporter_otlp_endpoint.as_deref()) {
        eprintln!("failed to initialize tracing: {err:#}");
        std::process::exit(1);
    }

    let _ = DEFAULT_PROVIDER.install_default();

    let database = match db::init_database(&cfg.mongo_uri).await {
        Ok(db) => db,
        Err(err) => {
            error!("database initialization failed: {err:#}");
            std::process::exit(1);
        }
    };

    if let Err(err) = db::ping(&database).await {
        error!("mongo ping failed: {err:#}");
        std::process::exit(1);
    }

    if let Err(err) = db::ensure_indexes(&database).await {
        warn!("failed to ensure mongo indexes: {err:#}");
    }

    let state = web::Data::new(AppState::new(cfg.clone(), database));
    let port = cfg.port;

    if let Err(err) = services::assets::ensure_bucket(&state).await {
        error!("failed to ensure rustfs bucket: {err:#}");
        std::process::exit(1);
    }

    services::queue::start_worker(state.clone()).await;
    start_nightly_sync_loop(state.clone()).await;

    info!("starting api on 0.0.0.0:{}", port);

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .wrap(NormalizePath::new(TrailingSlash::Trim))
            .wrap(app::middleware::cors(&cfg))
            .wrap(
                DefaultHeaders::new()
                    .add(("X-Frame-Options", "DENY"))
                    .add(("X-Content-Type-Options", "nosniff"))
                    .add(("Referrer-Policy", "strict-origin-when-cross-origin"))
                    .add(("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:")),
            )
            .service(
                web::scope("/api/v1")
                    .configure(routes::public::configure)
                    .configure(routes::assets::configure)
                    .configure(routes::auth::configure)
                    .configure(routes::account::configure)
                    .configure(routes::maps::configure)
                    .configure(routes::analytics::configure)
                    .configure(routes::admin::configure)
                    .configure(routes::jobs::configure)
                    .route("/health/liveness", web::get().to(routes::health::liveness))
                    .route(
                        "/health/readiness",
                        web::get().to(routes::health::readiness),
                    ),
            )
            .service(
                Files::new("/", "./apps/web/dist")
                    .index_file("index.html")
                    .default_handler(fn_service(files_fallback)),
            )
            .default_service(web::to(spa_or_api_404))
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::{should_spa_fallback, spa_or_api_404};
    use actix_web::{App, http::StatusCode, http::header, test, web};

    #[actix_web::test]
    async fn fallback_decision_matches_spa_expectations() {
        assert!(should_spa_fallback(
            &actix_web::http::Method::GET,
            "/catalog"
        ));
        assert!(should_spa_fallback(
            &actix_web::http::Method::GET,
            "/maps/base_building%2FFelderHouse.dd2vtt"
        ));
        assert!(should_spa_fallback(
            &actix_web::http::Method::HEAD,
            "/admin/users"
        ));
        assert!(!should_spa_fallback(
            &actix_web::http::Method::POST,
            "/catalog"
        ));
        assert!(!should_spa_fallback(
            &actix_web::http::Method::GET,
            "/api/v1/missing"
        ));
    }

    #[actix_web::test]
    async fn api_unknown_paths_return_json_404() {
        let app = test::init_service(App::new().default_service(web::to(spa_or_api_404))).await;
        let req = test::TestRequest::get().uri("/api/v1/missing").to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let content_type = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(content_type.contains("application/json"));
    }
}
