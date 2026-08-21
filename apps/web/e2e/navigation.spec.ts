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
