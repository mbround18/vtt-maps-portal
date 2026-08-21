use mongodb::Database;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Database,
}

impl AppState {
    pub fn new(config: Config, db: Database) -> Self {
        Self { config, db }
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
