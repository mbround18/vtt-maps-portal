use mongodb::{Collection, Database};

use crate::{
    config::Config,
    models::{Job, Map, MapDownload, MapView, MapVote, Session, SyncRun, User},
};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Database,
}

impl AppState {
    pub fn new(config: Config, db: Database) -> Self {
        Self { config, db }
    }

    // Every route/service module used to redefine these as identical private
    // one-liners (`state.db.collection("...")`) -- centralized here so there's
    // exactly one definition per collection instead of up to four copies.
    pub fn users_coll(&self) -> Collection<User> {
        self.db.collection("users")
    }
    pub fn sessions_coll(&self) -> Collection<Session> {
        self.db.collection("sessions")
    }
    pub fn maps_coll(&self) -> Collection<Map> {
        self.db.collection("maps")
    }
    pub fn sync_runs_coll(&self) -> Collection<SyncRun> {
        self.db.collection("sync_runs")
    }
    pub fn views_coll(&self) -> Collection<MapView> {
        self.db.collection("views")
    }
    pub fn downloads_coll(&self) -> Collection<MapDownload> {
        self.db.collection("downloads")
    }
    pub fn votes_coll(&self) -> Collection<MapVote> {
        self.db.collection("votes")
    }
    pub fn jobs_coll(&self) -> Collection<Job> {
        self.db.collection("jobs")
    }
}

pub mod middleware {
    use actix_cors::Cors;
    use actix_web::http::header;

    use crate::config::Config;

    pub fn cors(config: &Config) -> Cors {
        Cors::default()
            .allowed_origin(&config.allowed_origin)
            .allowed_methods(vec!["GET", "POST", "DELETE", "OPTIONS"])
            .allowed_headers(vec![
                header::CONTENT_TYPE,
                header::ACCEPT,
                header::HeaderName::from_static("x-csrf-token"),
                header::HeaderName::from_static("x-cookie-consent"),
            ])
            .supports_credentials()
            .max_age(3600)
    }
}

pub mod telemetry {
    use anyhow::Result;
    use opentelemetry::global;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_otlp::WithExportConfig;
    use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

    pub fn init_tracing(otlp_endpoint: Option<&str>) -> Result<()> {
        let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

        if let Some(endpoint) = otlp_endpoint {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_tonic()
                .with_endpoint(endpoint.to_string())
                .build()?;

            let provider = opentelemetry_sdk::trace::TracerProvider::builder()
                .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
                .build();

            let tracer = provider.tracer("vtt-maps-site");
            global::set_tracer_provider(provider);

            tracing_subscriber::registry()
                .with(filter)
                .with(tracing_subscriber::fmt::layer())
                .with(tracing_opentelemetry::layer().with_tracer(tracer))
                .init();
        } else {
            tracing_subscriber::registry()
                .with(filter)
                .with(tracing_subscriber::fmt::layer())
                .init();
        }

        Ok(())
    }
}
