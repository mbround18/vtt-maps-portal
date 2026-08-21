use anyhow::{Context, Result};
use mongodb::{Client, Database, options::ClientOptions};

/// Connects to MongoDB and returns the database handle configured by the
/// connection string's default database (or `vttmaps` if none is set).
pub async fn init_database(mongo_uri: &str) -> Result<Database> {
    let mut options = ClientOptions::parse(mongo_uri)
        .await
        .context("failed to parse MONGO_URI")?;
    options.app_name = Some("vtt-maps-site".to_string());
    let client = Client::with_options(options).context("failed to create mongo client")?;

    let db = match client.default_database() {
        Some(db) => db,
        None => client.database("vttmaps"),
    };

    Ok(db)
}

pub async fn ping(db: &Database) -> Result<()> {
    db.run_command(mongodb::bson::doc! {"ping": 1})
        .await
        .context("mongo ping failed")?;
    Ok(())
}

pub async fn ensure_indexes(db: &Database) -> Result<()> {
    use mongodb::{IndexModel, bson::doc, options::IndexOptions};

    let users = db.collection::<mongodb::bson::Document>("users");
    users
        .create_index(
            IndexModel::builder()
                .keys(doc! {"discord_id": 1})
                .options(IndexOptions::builder().unique(true).build())
                .build(),
        )
        .await
        .ok();

    let maps = db.collection::<mongodb::bson::Document>("maps");
    maps.create_index(
        IndexModel::builder()
            .keys(doc! {"path": 1})
            .options(IndexOptions::builder().unique(true).build())
            .build(),
    )
    .await
    .ok();

    let oauth_states = db.collection::<mongodb::bson::Document>("oauth_states");
    oauth_states
        .create_index(
            IndexModel::builder()
                .keys(doc! {"expires_at": 1})
                .options(
                    IndexOptions::builder()
                        .expire_after(std::time::Duration::from_secs(0))
                        .build(),
                )
                .build(),
        )
        .await
        .ok();

    let sessions = db.collection::<mongodb::bson::Document>("sessions");
    sessions
        .create_index(IndexModel::builder().keys(doc! {"user_id": 1}).build())
        .await
        .ok();

    let jobs = db.collection::<mongodb::bson::Document>("jobs");
    jobs.create_index(
        IndexModel::builder()
            .keys(doc! {"status": 1, "available_at": 1})
            .build(),
    )
    .await
    .ok();

    Ok(())
}
