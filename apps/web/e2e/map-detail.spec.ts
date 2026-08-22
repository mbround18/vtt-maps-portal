import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const MAP_ID = "test-map-1";

const MAP_DETAIL_PAYLOAD = {
  map: {
    id: MAP_ID,
    name: "Dwarven Forge",
    path: "maps/dwarven-forge.dd2vtt",
    tags: ["Dungeons", "Dwarven Forge"],
    about_md: "A sprawling underground forge.",
    about_html: "<p>A sprawling underground forge.</p>",
    poi: [{ id: "poi-1", x: 10, y: 20, label: "Anvil", note: "" }],
    status: "ready"
  },
  stats: { views: 128, downloads: 42, votes: 9 },
  preview: {
    available: true,
    // Deliberately much larger than the viewport, so native (1x) scale would
    // render heavily cropped/"zoomed in" -- exercises the fit-to-viewport default.
    width: 4000,
    height: 3000,
    image_url: "https://example.com/dwarven-forge.webp",
    dd2vtt_download_url: "/assets/dwarven-forge.dd2vtt"
  },
  donation_url: null,
  user_voted: false
};

type AuthUser = { role: string; is_super_admin: boolean } | null;

async function mockApi(page: Page, user: AuthUser) {
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

  await page.route(`**/api/v1/maps/${MAP_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MAP_DETAIL_PAYLOAD) })
  );

  await page.route(`**/api/v1/maps/${MAP_ID}/related**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) })
  );

  await page.route(`**/api/v1/maps/${MAP_ID}/view-start`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
  await page.route(`**/api/v1/maps/${MAP_ID}/view-end`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
  await page.route("**/api/v1/analytics/donation", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );

  await page.route(`**/api/v1/admin/maps/metadata/${MAP_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", map_id: MAP_ID })
    })
  );

  await page.route(`**/api/v1/maps/${MAP_ID}/download`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
  await page.route("**/assets/dwarven-forge.dd2vtt", (route) =>
    route.fulfill({ status: 200, contentType: "application/octet-stream", body: "fake-dd2vtt-bytes" })
  );
}

test.describe("map detail page", () => {
  test("guest visitors never see the POI editor or the metadata editor", async ({ page }) => {
    await mockApi(page, null);
    await page.goto(`/maps/${MAP_ID}`);
    await expect(page.getByRole("heading", { name: "Dwarven Forge" })).toBeVisible();

    await expect(page.getByText("POI Edit Mode")).toHaveCount(0);
    await expect(page.getByText("Map Metadata Editor")).toHaveCount(0);
  });

  test("regular admins (not the super admin) cannot see the POI or metadata editors", async ({ page }) => {
    await mockApi(page, { role: "admin", is_super_admin: false });
    await page.goto(`/maps/${MAP_ID}`);
    await expect(page.getByRole("heading", { name: "Dwarven Forge" })).toBeVisible();

    // POI editor is feature-flagged off regardless of role.
    await expect(page.getByText("POI Edit Mode")).toHaveCount(0);
    // Metadata editor requires super admin, not just admin.
    await expect(page.getByText("Map Metadata Editor")).toHaveCount(0);
  });

  test("super admin sees the metadata editor in view mode, and can switch to edit mode", async ({ page }) => {
    await mockApi(page, { role: "admin", is_super_admin: true });
    await page.goto(`/maps/${MAP_ID}`);
    await expect(page.getByRole("heading", { name: "Dwarven Forge" })).toBeVisible();

    // POI editor stays off even for the super admin -- it's feature-flagged, not role-gated.
    await expect(page.getByText("POI Edit Mode")).toHaveCount(0);

    await expect(page.getByText("Map Metadata Editor")).toBeVisible();
    await expect(page.getByText("View Mode")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit Metadata" })).toBeVisible();
    // Read-only view mode has no editable display-name field.
    await expect(page.getByLabel("Display Name")).toHaveCount(0);

    await page.getByRole("button", { name: "Edit Metadata" }).click();

    await expect(page.getByText("Edit Mode")).toBeVisible();
    await expect(page.getByLabel("Display Name")).toHaveValue("Dwarven Forge");
    await expect(page.getByRole("button", { name: "Save Metadata" })).toBeVisible();

    await page.getByRole("button", { name: "Discard Changes" }).click();
    await expect(page.getByText("View Mode")).toBeVisible();
  });

  test("stat labels stay inside their tiles and don't overflow the viewport", async ({ page }) => {
    await mockApi(page, null);
    await page.goto(`/maps/${MAP_ID}`);

    const downloadsLabel = page.getByText("Downloads", { exact: true });
    await expect(downloadsLabel).toBeVisible();

    const labelBox = await downloadsLabel.boundingBox();
    const tileBox = await downloadsLabel.locator("..").boundingBox();
    expect(labelBox).not.toBeNull();
    expect(tileBox).not.toBeNull();

    // The label must not spill past the right edge of its containing tile...
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(tileBox!.x + tileBox!.width + 1);
    // ...or off the right edge of the viewport.
    const viewportWidth = page.viewportSize()?.width ?? 1280;
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(viewportWidth + 1);

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(hasHorizontalOverflow).toBe(false);
  });

  test("the map preview loads fully zoomed out to fit the viewport, not native pixel scale", async ({ page }) => {
    await mockApi(page, null);
    await page.goto(`/maps/${MAP_ID}`);

    const img = page.getByAltText("Dwarven Forge");
    await expect(img).toBeVisible();

    const viewportBox = await img.locator("../..").boundingBox();
    const imgBox = await img.boundingBox();
    expect(viewportBox).not.toBeNull();
    expect(imgBox).not.toBeNull();

    // The 4000x3000 source image must be scaled down to fit inside the
    // viewer, not shown at native size (which would be many times larger
    // than the container and look "zoomed in").
    expect(imgBox!.width).toBeLessThanOrEqual(viewportBox!.width + 1);
    expect(imgBox!.height).toBeLessThanOrEqual(viewportBox!.height + 1);
  });

  test("wheeling over the map canvas zooms it without scrolling the page underneath", async ({ page }) => {
    await mockApi(page, null);
    await page.goto(`/maps/${MAP_ID}`);

    const img = page.getByAltText("Dwarven Forge");
    await expect(img).toBeVisible();
    const transformLayer = img.locator("..");
    const viewportBox = await img.locator("../..").boundingBox();
    expect(viewportBox).not.toBeNull();

    const before = await transformLayer.evaluate((el) => (el as HTMLElement).style.transform);

    await page.mouse.move(viewportBox!.x + viewportBox!.width / 2, viewportBox!.y + viewportBox!.height / 2);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 400);
    const scrollAfter = await page.evaluate(() => window.scrollY);

    // Page must not have scrolled...
    expect(scrollAfter).toBe(scrollBefore);
    // ...but the wheel still reached the canvas and changed its zoom/pan transform.
    const after = await transformLayer.evaluate((el) => (el as HTMLElement).style.transform);
    expect(after).not.toBe(before);
  });

  test("middle-mouse-button drag pans the map, WebGL-map-viewer style", async ({ page }) => {
    await mockApi(page, null);
    await page.goto(`/maps/${MAP_ID}`);

    const img = page.getByAltText("Dwarven Forge");
    await expect(img).toBeVisible();
    const transformLayer = img.locator("..");
    const viewportBox = await img.locator("../..").boundingBox();
    expect(viewportBox).not.toBeNull();

    const before = await transformLayer.evaluate((el) => (el as HTMLElement).style.transform);

    const startX = viewportBox!.x + viewportBox!.width / 2;
    const startY = viewportBox!.y + viewportBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(startX + 90, startY + 45, { steps: 5 });
    await page.mouse.up({ button: "middle" });

    const after = await transformLayer.evaluate((el) => (el as HTMLElement).style.transform);
    expect(after).not.toBe(before);
  });

  test("downloading DD2VTT opens a donate-first modal with a 5s countdown, then saves the file without navigating away", async ({
    page
  }) => {
    await mockApi(page, { role: "user", is_super_admin: false });
    await page.goto(`/maps/${MAP_ID}`);

    const popups: number[] = [];
    page.on("popup", () => popups.push(1));

    await page.getByRole("button", { name: "Download DD2VTT" }).click();
    await expect(page.getByText("Support the project before you download")).toBeVisible();
    await expect(page.getByText(/starts automatically in 5s/)).toBeVisible();

    const [downloadRequest] = await Promise.all([
      page.waitForRequest("**/assets/dwarven-forge.dd2vtt"),
      page.getByRole("button", { name: "Download Now" }).click()
    ]);
    expect(downloadRequest).toBeTruthy();

    // Dialog closes itself once the file has been handed off to the browser.
    await expect(page.getByText("Support the project before you download")).toHaveCount(0, { timeout: 5000 });
    // The file is saved via a blob download, not by navigating/opening the URL.
    expect(popups).toHaveLength(0);
  });

  test("downloading DD2VTT sends the session cookie to the API-proxied asset route (regression: credentials must not be omitted)", async ({
    page,
    context
  }) => {
    // Mirrors production: since maps were switched to be proxied through the
    // API (rather than a public RustFS URL), the asset route requires the
    // session cookie. If the download fetch omits credentials, the API
    // 401s, the fallback window.open() happens too late to count as a user
    // gesture, and the browser silently blocks the popup -- the user clicks
    // "Download Now" and nothing happens.
    const proxiedPayload = {
      ...MAP_DETAIL_PAYLOAD,
      preview: { ...MAP_DETAIL_PAYLOAD.preview, dd2vtt_download_url: `/api/v1/maps/${MAP_ID}/asset` }
    };
    await context.addCookies([
      { name: "session", value: "test-session-token", domain: "localhost", path: "/" }
    ]);
    await page.route(`**/api/v1/maps/${MAP_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(proxiedPayload) })
    );
    await mockApi(page, { role: "user", is_super_admin: false });
    // Re-register the map-detail route after mockApi so the proxied payload wins.
    await page.route(`**/api/v1/maps/${MAP_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(proxiedPayload) })
    );

    let sawCookieHeader = false;
    await page.route(`**/api/v1/maps/${MAP_ID}/asset`, (route) => {
      const cookieHeader = route.request().headers()["cookie"] ?? "";
      sawCookieHeader = cookieHeader.includes("session=test-session-token");
      route.fulfill({ status: 200, contentType: "application/octet-stream", body: "fake-dd2vtt-bytes" });
    });

    await page.goto(`/maps/${MAP_ID}`);

    await page.getByRole("button", { name: "Download DD2VTT" }).click();
    await expect(page.getByText("Support the project before you download")).toBeVisible();

    const [downloadRequest] = await Promise.all([
      page.waitForRequest(`**/api/v1/maps/${MAP_ID}/asset`),
      page.getByRole("button", { name: "Download Now" }).click()
    ]);
    expect(downloadRequest).toBeTruthy();

    await expect(page.getByText("Support the project before you download")).toHaveCount(0, { timeout: 5000 });
    expect(sawCookieHeader).toBe(true);
  });

  test("canceling the DD2VTT dialog does not download the file", async ({ page }) => {
    await mockApi(page, { role: "user", is_super_admin: false });
    await page.goto(`/maps/${MAP_ID}`);

    let downloadRequested = false;
    page.on("request", (req) => {
      if (req.url().includes("dwarven-forge.dd2vtt")) downloadRequested = true;
    });

    await page.getByRole("button", { name: "Download DD2VTT" }).click();
    await expect(page.getByText("Support the project before you download")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Support the project before you download")).toHaveCount(0);

    await page.waitForTimeout(300);
    expect(downloadRequested).toBe(false);
  });
});
