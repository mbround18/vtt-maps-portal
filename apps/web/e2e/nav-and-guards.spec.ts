import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type AuthUser = { role: string; is_super_admin: boolean } | null;

async function mockAuth(page: Page, user: AuthUser) {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        user
          ? {
              authenticated: true,
              user: {
                id: "u1",
                discord_id: "1",
                username: "Tester",
                role: user.role,
                is_super_admin: user.is_super_admin,
                avatar_url: null
              }
            }
          : { authenticated: false, user: null }
      )
    })
  );
  // Best-effort stubs so pages behind the guards don't hang on unrelated fetches.
  await page.route("**/api/v1/auth/sessions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [] }) })
  );
  await page.route("**/api/v1/account/interactions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ summary: { views: 0, downloads: 0, votes: 0 }, recent: { views: [], downloads: [], votes: [] } })
    })
  );
  await page.route("**/api/v1/admin/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], users: [] }) })
  );
}

test.describe("navigation bar auth state", () => {
  test("guests see a Login link and no profile avatar", async ({ page }) => {
    await mockAuth(page, null);
    await page.goto("/");
    await expect(page.getByRole("navigation").getByRole("link", { name: "Login" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveCount(0);
  });

  test("signed-in users see a profile avatar instead of Login, linking to /account", async ({ page }) => {
    await mockAuth(page, { role: "user", is_super_admin: false });
    await page.goto("/");
    await expect(page.getByRole("navigation").getByRole("link", { name: "Login" })).toHaveCount(0);

    const avatarLink = page.getByRole("link", { name: "Your profile" });
    await expect(avatarLink).toBeVisible();
    await avatarLink.click();
    await expect(page).toHaveURL(/\/account$/);
  });

  test("admin nav links only appear for the super admin", async ({ page }) => {
    await mockAuth(page, { role: "admin", is_super_admin: false });
    await page.goto("/");
    await expect(page.getByRole("navigation").getByRole("link", { name: "Admin Panel" })).toHaveCount(0);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Users" })).toHaveCount(0);
  });

  test("super admin sees the admin nav links", async ({ page }) => {
    await mockAuth(page, { role: "admin", is_super_admin: true });
    await page.goto("/");
    await expect(page.getByRole("navigation").getByRole("link", { name: "Admin Panel" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Users" })).toBeVisible();
  });
});

test.describe("home page", () => {
  test("guests see the Sign In with Discord CTA and stay on the landing page", async ({ page }) => {
    await mockAuth(page, null);
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Sign In with Discord" })).toBeVisible();
  });

  test("signed-in visitors can still browse the home page, but the Sign In CTA is gone", async ({ page }) => {
    await mockAuth(page, { role: "user", is_super_admin: false });
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Sign In with Discord" })).toHaveCount(0);
  });

  test("shows the true total map count", async ({ page }) => {
    await mockAuth(page, null);
    await page.route("**/api/v1/maps?limit=48", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [{ id: "m1", name: "Map One", path: "maps/one.dd2vtt" }], total: 317 })
      })
    );
    await page.goto("/");
    await expect(page.getByText("317 maps and counting")).toBeVisible();
  });
});

test.describe("route guards", () => {
  test("guests hitting /account or /admin/users directly are sent to /login", async ({ page }) => {
    await mockAuth(page, null);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("signed-in non-super-admins can reach /account but are bounced from /admin/users", async ({ page }) => {
    await mockAuth(page, { role: "user", is_super_admin: false });
    await page.goto("/account");
    await expect(page).toHaveURL(/\/account$/);

    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/$/);
  });

  test("the super admin can reach /admin/users directly", async ({ page }) => {
    await mockAuth(page, { role: "admin", is_super_admin: true });
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/admin\/users$/);
  });
});
