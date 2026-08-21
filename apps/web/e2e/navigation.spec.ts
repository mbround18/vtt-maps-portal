import { expect, test } from "@playwright/test";

test.describe("navigation", () => {
  test("home page renders hero and nav", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "VTT Maps" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /cinematic worlds/i })).toBeVisible();
    await expect(page.getByRole("link", { name: "Explore Catalog" })).toBeVisible();
  });

  test("nav links move between catalog, login, and home", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("navigation").getByRole("link", { name: "Catalog" }).click();
    await expect(page).toHaveURL(/\/catalog$/);

    await page.getByRole("navigation").getByRole("link", { name: "Login" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("Continue with Discord")).toBeVisible();

    await page.getByRole("navigation").getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("unknown routes redirect to home", async ({ page }) => {
    await page.goto("/this-route-does-not-exist");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: /cinematic worlds/i })).toBeVisible();
  });

  test("no console errors on initial load", async ({ page }) => {
    // This test only cares about errors the frontend itself produces --
    // without a backend running (there isn't one in CI), an unmocked
    // fetch/proxy failure would surface as its own "Failed to load resource"
    // console error and drown out the thing we're actually checking.
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false, user: null }) })
    );
    await page.route("**/api/v1/public/github-stars", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stars: null }) })
    );
    await page.route("**/api/v1/maps?limit=48", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0 }) })
    );

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(errors).toEqual([]);
  });
});
