use actix_web::{HttpResponse, web};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::scope("/public").route("/github-stars", web::get().to(github_stars)));
}

async fn github_stars() -> HttpResponse {
    let owner = "MBRound18";
    let repo = "vtt-maps";
    let url = format!("https://api.github.com/repos/{owner}/{repo}");

    let response = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::USER_AGENT, "vtt-maps-site")
        .send()
        .await;

    let stars = match response {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("stargazers_count").and_then(|v| v.as_i64())),
        _ => None,
    };

    HttpResponse::Ok().json(serde_json::json!({
        "owner": owner,
        "repo": repo,
        "stars": stars
    }))
}
