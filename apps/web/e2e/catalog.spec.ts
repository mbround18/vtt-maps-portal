import { expect, test } from "@playwright/test";

test.describe("catalog page", () => {
  test("renders search controls even with an empty/errored map list", async ({ page }) => {
    await page.goto("/catalog");
    await expect(page.getByRole("heading", { name: /find your next battleground/i })).toBeVisible();
    await expect(page.getByPlaceholder("Search maps by name or path")).toBeVisible();
  });

  test("typing in the search box does not crash the page", async ({ page }) => {
    await page.goto("/catalog");
    const search = page.getByPlaceholder("Search maps by name or path");
    await search.fill("dwarven forge");
    await expect(search).toHaveValue("dwarven forge");
  });

  test("the total badge reflects the server's true total, not just the first page loaded", async ({ page }) => {
    // Server reports 250 maps total but only hands back one page (2 items) --
    // the "total" badge must show the server total, not the loaded-page count.
    await page.route("**/api/v1/maps?limit=48", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { id: "m1", name: "Map One", path: "maps/one.dd2vtt" },
            { id: "m2", name: "Map Two", path: "maps/two.dd2vtt" }
          ],
          next_cursor: "cursor-2",
          total: 250
        })
      })
    );

    await page.goto("/catalog");
    await expect(page.getByText("2 shown")).toBeVisible();
    await expect(page.getByText("250 total")).toBeVisible();
  });
});
