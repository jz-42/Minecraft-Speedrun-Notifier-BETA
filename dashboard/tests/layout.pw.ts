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

type R = { x: number; y: number; w: number; h: number };

async function rect(page: import("@playwright/test").Page, testId: string) {
  const r = await page.getByTestId(testId).boundingBox();
  expect(r, `missing bounding box for ${testId}`).toBeTruthy();
  return {
    x: Math.round((r as any).x),
    y: Math.round((r as any).y),
    w: Math.round((r as any).width),
    h: Math.round((r as any).height),
  } satisfies R;
}

async function rectOptional(
  page: import("@playwright/test").Page,
  testId: string
) {
  const r = await page.getByTestId(testId).boundingBox();
  if (!r) return null;
  return {
    x: Math.round((r as any).x),
    y: Math.round((r as any).y),
    w: Math.round((r as any).width),
    h: Math.round((r as any).height),
  } satisfies R;
}

function right(r: R) {
  return r.x + r.w;
}

function bottom(r: R) {
  return r.y + r.h;
}

test.describe("dashboard layout invariants", () => {
  for (const { name, width, height } of [
    { name: "phone-390", width: 390, height: 844 },
    { name: "tablet-768", width: 768, height: 900 },
    { name: "laptop-1366", width: 1366, height: 900 },
    { name: "desktop-1280", width: 1280, height: 800 },
    { name: "desktop-1512", width: 1512, height: 900 },
    { name: "desktop-1920", width: 1920, height: 1080 },
    { name: "desktop-2560", width: 2560, height: 1440 },
    { name: "ultrawide-3440", width: 3440, height: 1440 },
  ]) {
    test(`${name} header alignment @layout`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      mockDashboardApi(page);

      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page.locator(".grid")).toBeVisible();
      await page.waitForTimeout(100);

      const frame = await rect(page, "header-frame");
      const titleRow = await rect(page, "header-titleRow");
      const brandRow = await rect(page, "header-brandRow");
      const title = await rect(page, "header-title");
      const meta = await rect(page, "header-meta");
      const artSlot = await rectOptional(page, "header-artSlot");
      const dragon = await rectOptional(page, "header-dragon");

      // Basic sanity: header pieces should be on-screen.
      expect(frame.w).toBeGreaterThan(0);
      expect(titleRow.w).toBeGreaterThan(0);
      expect(brandRow.w).toBeGreaterThan(0);

      // Grid alignment: art column and text column should share a top baseline.
      expect(Math.abs(brandRow.y - titleRow.y)).toBeLessThanOrEqual(2);

      // Desktop lockup: title should sit right of the art column with a reasonable gap.
      // On small screens the art is hidden, so skip this constraint.
      if (width > 900 && artSlot) {
        const gap = title.x - right(artSlot);
        expect(gap).toBeGreaterThanOrEqual(8);
        expect(gap).toBeLessThanOrEqual(60);
      }

      // Art is decorative and allowed to "bleed" slightly left/up, but should stay near the art column.
      if (width > 900 && artSlot && dragon) {
        expect(dragon.w).toBeGreaterThan(200);
        expect(dragon.h).toBeGreaterThan(160);
        // Don’t let the dragon get visibly chopped off-screen.
        expect(dragon.x).toBeGreaterThanOrEqual(-10);
        expect(dragon.x).toBeLessThanOrEqual(artSlot.x + 14);
        expect(right(dragon)).toBeGreaterThanOrEqual(artSlot.x + 160);
      }

      // Title and meta should not overlap the art column (desktop lockup).
      if (width > 900 && artSlot) {
        expect(title.x).toBeGreaterThanOrEqual(right(artSlot) + 8);
        expect(meta.x).toBeGreaterThanOrEqual(right(artSlot) + 8);
      }

      // Meta should appear below the title line (or at least not above it).
      expect(meta.y).toBeGreaterThanOrEqual(title.y);

      // Everything should remain within the header row area (no crazy vertical drift).
      expect(bottom(meta)).toBeLessThanOrEqual(bottom(frame) + 240);
    });
  }
});

