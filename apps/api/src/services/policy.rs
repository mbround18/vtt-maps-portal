use anyhow::{Result, bail};

#[derive(Debug, Clone, Copy)]
pub enum Permission {
    AdminRead,
    AdminWrite,
    // No route currently gates image downloads (webp images are served
    // directly from RustFS public URLs), but the permission matrix keeps
    // this variant for parity with the rest of the RBAC surface.
    #[allow(dead_code)]
    MapImageDownload,
    MapDd2vttDownload,
    MapVote,
    AccountRead,
    AccountDelete,
}

fn role_allows(role: &str, permission: Permission) -> bool {
    if role == "admin" {
        return true;
    }

    match permission {
        Permission::AdminRead | Permission::AdminWrite => false,
        Permission::MapImageDownload => matches!(role, "guest" | "user" | "contributor"),
        Permission::MapDd2vttDownload
        | Permission::MapVote
        | Permission::AccountRead
        | Permission::AccountDelete => {
            matches!(role, "user" | "contributor")
        }
    }
}

pub fn authorize(role: &str, permission: Permission) -> Result<()> {
    if role_allows(role, permission) {
        Ok(())
    } else {
        bail!("forbidden")
    }
}

#[cfg(test)]
mod tests {
    use super::{Permission, authorize};

    #[test]
    fn policy_matrix_deny_by_default_for_non_admin() {
        let roles = ["guest", "user", "contributor", "admin", "unknown"];
        let permissions = [
            Permission::AdminRead,
            Permission::AdminWrite,
            Permission::MapImageDownload,
            Permission::MapDd2vttDownload,
            Permission::MapVote,
            Permission::AccountRead,
            Permission::AccountDelete,
        ];

        for role in roles {
            for permission in permissions {
                let allowed = authorize(role, permission).is_ok();
                match (role, permission) {
                    ("admin", _) => assert!(allowed),
                    ("guest", Permission::MapImageDownload) => assert!(allowed),
                    (
                        "user",
                        Permission::MapImageDownload
                        | Permission::MapDd2vttDownload
                        | Permission::MapVote
                        | Permission::AccountRead
                        | Permission::AccountDelete,
                    ) => assert!(allowed),
                    (
                        "contributor",
                        Permission::MapImageDownload
                        | Permission::MapDd2vttDownload
                        | Permission::MapVote
                        | Permission::AccountRead
                        | Permission::AccountDelete,
                    ) => assert!(allowed),
                    _ => assert!(!allowed),
                }
            }
        }
    }
}
