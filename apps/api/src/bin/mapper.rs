use std::process::Command;

use anyhow::{Context, Result, bail};
use api::{app::AppState, config::Config, db, services::assets};
use clap::{Parser, Subcommand};
use tempfile::TempDir;

/// Operational CLI for the VTT Maps backend. Designed to run standalone
/// (e.g. as a Kubernetes CronJob) using the same MONGO_URI/RUSTFS_*/GITHUB_*
/// env vars as the API server.
#[derive(Parser)]
#[command(name = "mapper", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Clone the configured GitHub maps repo into a temp dir and ingest any
    /// maps not already known, then extract their images. Prints a summary
    /// and exits non-zero if any map failed, so it can drive a CronJob's
    /// success/failure status.
    Preload {
        /// Override the configured GITHUB_BRANCH for this run.
        #[arg(long)]
        branch: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt().with_target(false).init();

    let cli = Cli::parse();
    let mut cfg = Config::from_env().context("failed to load config")?;

    match cli.command {
        Commands::Preload { branch } => {
            if let Some(branch) = branch {
                cfg.github_branch = branch;
            }
            run_preload(cfg).await
        }
    }
}

async fn run_preload(cfg: Config) -> Result<()> {
    let database = db::init_database(&cfg.mongo_uri)
        .await
        .context("failed to connect to mongo")?;
    db::ping(&database).await.context("mongo ping failed")?;
    if let Err(err) = db::ensure_indexes(&database).await {
        tracing::warn!("failed to ensure mongo indexes: {err:#}");
    }
    let state = AppState::new(cfg.clone(), database);
    assets::ensure_bucket(&state)
        .await
        .context("failed to ensure rustfs bucket")?;

    let tmp = TempDir::new().context("failed to create temp dir")?;
    tracing::info!(
        repo = %cfg.github_url,
        branch = %cfg.github_branch,
        dir = %tmp.path().display(),
        "cloning maps repo"
    );

    // Token-authenticated HTTPS clone URL — works for public and private
    // repos alike, needs no SSH deploy key. Never logged: it embeds the
    // GitHub token.
    let clone_url = format!(
        "https://x-access-token:{}@github.com/{}/{}.git",
        cfg.github_token, cfg.github_owner, cfg.github_repo
    );

    let status = Command::new("git")
        // Never fall back to an interactive credential prompt — a bad
        // token must fail fast, not hang forever in a non-interactive
        // CronJob pod.
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "clone",
            "--depth",
            "1",
            "--branch",
            &cfg.github_branch,
            "--single-branch",
            &clone_url,
        ])
        .arg(tmp.path())
        .status()
        .context("failed to invoke `git clone` (is git installed in this image?)")?;
    if !status.success() {
        bail!("git clone exited with status {status}");
    }

    let maps_dir = tmp.path().join("maps");
    if !maps_dir.is_dir() {
        bail!("cloned repo has no top-level maps/ directory");
    }

    let summary = assets::preload_from_directory(&state, &maps_dir)
        .await
        .context("preload failed")?;

    tracing::info!(
        run_id = %summary.run_id,
        maps_found = summary.maps_found,
        maps_new = summary.maps_new,
        errors = summary.errors,
        "preload complete"
    );

    // tmp dir (and the clone) is removed automatically here on drop.
    if summary.errors > 0 {
        bail!(
            "preload completed with {} error(s), see sync_runs",
            summary.errors
        );
    }
    Ok(())
}
