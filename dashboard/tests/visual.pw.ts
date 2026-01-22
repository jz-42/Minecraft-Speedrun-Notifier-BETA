import { test, expect } from "@playwright/test";

function mockDashboardApi(page: import("@playwright/test").Page) {
  const streamers = Array.from({ length: 13 }, (_, i) => String(i + 1));

  page.route("**/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        streamers,
        clock: "IGT",
        quietHours: [],
        defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
        profiles: {},
      }),
    });
  });

  page.route("**/profiles?*", async (route) => {
    const profiles: Record<string, any> = {};
    for (const s of streamers) profiles[s] = { avatarUrl: null };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, profiles }),
    });
  });

  page.route("**/status?*", async (route) => {
    const statuses: Record<string, any> = {};
    for (const s of streamers) {
      statuses[s] = {
        runId: null,
        isLive: false,
        isActive: false,
        runIsActive: false,
        lastMilestone: null,
        lastMilestoneMs: null,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, statuses }),
    });
  });
}

test.describe("dashboard visual layout", () => {
  for (const { name, width, height } of [
    { name: "desktop-1280", width: 1280, height: 800 },
    { name: "desktop-1512", width: 1512, height: 900 },
    { name: "desktop-1920", width: 1920, height: 1080 },
  ]) {
    test(`${name} layout snapshot @visual`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      mockDashboardApi(page);

      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator(".grid")).toBeVisible();
      await page.waitForTimeout(100);

      await expect(page).toHaveScreenshot(`${name}.png`, {
        fullPage: true,
      });
    });
  }
});


