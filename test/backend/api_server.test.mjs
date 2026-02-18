/**
 * API contract tests (Express)
 *
 * Why these exist:
 * - Cursor/AI changes often break wiring: endpoints renamed, CORS too strict, etc.
 * - These tests are fast (<50ms) and verify the public API contract without binding a real port.
 *
 * What we're testing:
 * - CORS allowlist logic (localhost any port).
 * - /config read + write persistence.
 * - /notify/test calls the notification router.
 *
 * If this file fails:
 * - The dashboard may be unable to load/save config.
 * - The “Test desktop notification” button may be broken.
 * - Dev CORS may break when Vite changes ports.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

import server from "../../src/api/server.js";

const { createApp, defaultIsAllowedOrigin } = server;

function tmpConfigPath() {
  return path.join(
    os.tmpdir(),
    `runalert-config-${Date.now()}-${Math.random()}.json`
  );
}

async function withLocalServer(app, fn) {
  // Avoid binding a real port (blocked in some sandboxes). Supertest can drive the app directly.
  return await fn(request(app));
}

describe("api/server", () => {
  let configPath;
  let configDir;

  beforeEach(() => {
    // Each test gets its own temporary config file so tests don't touch your real config.json.
    configPath = tmpConfigPath();
    configDir = path.join(
      os.tmpdir(),
      `runalert-configs-${Date.now()}-${Math.random()}`
    );
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          streamers: ["xQcOW"],
          clock: "IGT",
          quietHours: "00:30-07:15",
          defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
          profiles: {},
        },
        null,
        2
      )
    );
  });

  // Test: defaultIsAllowedOrigin allows localhost ports and blocks others
  it("defaultIsAllowedOrigin allows localhost ports and blocks others", () => {
    // Beginner summary: Vite can switch ports (5173 -> 5174). We must allow localhost:anyPort in dev.
    expect(defaultIsAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(defaultIsAllowedOrigin("http://127.0.0.1:5174")).toBe(true);
    expect(defaultIsAllowedOrigin("https://localhost:5173")).toBe(false);
    expect(defaultIsAllowedOrigin("http://evil.com")).toBe(false);
  });

  // Test: GET /config returns config json
  it("GET /config returns config json", async () => {
    // Beginner summary: dashboard boot depends on this returning valid JSON.
    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman: { getRecentRunId: vi.fn(), getWorld: vi.fn() },
    });

    const r = await withLocalServer(app, (r) => r.get("/config"));
    expect(r.status).toBe(200);
    expect(r.body.streamers).toEqual(["xQcOW"]);
  });

  // Test: GET /config with token creates a per-user config file
  it("GET /config with token creates a per-user config file", async () => {
    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman: { getRecentRunId: vi.fn(), getWorld: vi.fn() },
    });

    const token = "testtoken123";
    const r = await withLocalServer(app, (r) => r.get(`/config?token=${token}`));
    expect(r.status).toBe(200);
    expect(r.body.streamers).toEqual(["xQcOW"]);

    const tokenPath = path.join(configDir, `${token}.json`);
    expect(fs.existsSync(tokenPath)).toBe(true);
  });

  // Test: PUT /config validates and persists
  it("PUT /config validates and persists", async () => {
    // Beginner summary: dashboard save depends on this endpoint persisting config.json.
    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman: { getRecentRunId: vi.fn(), getWorld: vi.fn() },
    });

    const next = {
      streamers: ["xQcOW", "forsen"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    const r = await withLocalServer(app, (r) => r.put("/config").send(next));
    expect(r.status).toBe(200);

    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(saved.streamers).toEqual(["xQcOW", "forsen"]);
  });

  // Test: PUT /config with token writes to per-user file only
  it("PUT /config with token writes to per-user file only", async () => {
    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman: { getRecentRunId: vi.fn(), getWorld: vi.fn() },
    });

    const token = "user42";
    const next = {
      streamers: ["xQcOW", "snoop"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    const r = await withLocalServer(app, (r) =>
      r.put(`/config?token=${token}`).send(next)
    );
    expect(r.status).toBe(200);

    const base = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(base.streamers).toEqual(["xQcOW"]);

    const tokenPath = path.join(configDir, `${token}.json`);
    const saved = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    expect(saved.streamers).toEqual(["xQcOW", "snoop"]);
  });

  // Test: PUT /config rejects too many streamers
  it("PUT /config rejects too many streamers", async () => {
    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman: { getRecentRunId: vi.fn(), getWorld: vi.fn() },
    });

    const tooMany = Array.from({ length: 16 }, (_, i) => `s${i}`);
    const next = {
      streamers: tooMany,
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    const r = await withLocalServer(app, (r) => r.put("/config").send(next));
    expect(r.status).toBe(400);
    expect(String(r.body?.error || "")).toContain("too many streamers");
  });

  // Test: POST /notify/test calls notifySend
  it("POST /notify/test calls notifySend", async () => {
    // Beginner summary: clicking “Test desktop notification” should call the notifier router.
    const notifySend = vi.fn(async () => {});
    const app = createApp({
      configPath,
      configDir,
      notifySend,
      paceman: { getRecentRunId: vi.fn(), getWorld: vi.fn() },
    });

    const r = await withLocalServer(app, (r) =>
      r.post("/notify/test").send({ title: "t", message: "m" })
    );
    expect(r.status).toBe(200);
    expect(notifySend).toHaveBeenCalledWith({
      channel: "desktop",
      title: "t",
      message: "m",
    });
  });

  // Test: GET /status returns per-streamer isLive based on paceman world.isLive
  it("GET /status returns per-streamer isLive based on paceman world.isLive", async () => {
    // Beginner summary: dashboard polls this endpoint for tile indicators (active + last milestone).
    const paceman = {
      getRecentRunId: vi
        .fn()
        .mockImplementation(async (name) => (name === "xQcOW" ? 123 : null)),
      getWorld: vi.fn().mockImplementation(async (runId) =>
        runId === 123
          ? {
              isLive: true,
              data: { updateTime: 1000, insertTime: 900, nether: 111_000 },
            }
          : { isLive: false, data: { updateTime: 1 } }
      ),
    };

    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman,
    });

    const r = await withLocalServer(app, (r) =>
      r.get("/status?names=xQcOW,forsen")
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.statuses.xQcOW.isLive).toBe(true);
    expect(r.body.statuses.xQcOW.isActive).toBe(true);
    expect(r.body.statuses.xQcOW.runIsActive).toBe(true);
    expect(r.body.statuses.xQcOW.lastMilestone).toBe("nether");
    expect(r.body.statuses.xQcOW.runStartSec).toBe(900);
    expect(r.body.statuses.forsen.isLive).toBe(false);
    expect(r.body.statuses.forsen.isActive).toBe(false);
    expect(r.body.statuses.forsen.runIsActive).toBe(false);
    expect(r.body.statuses.forsen.lastMilestone).toBe(null);
  });

  // Test: GET /status marks isActive when the run updated recently (even if isLive=false)
  it("GET /status marks isActive when the run updated recently (even if isLive=false)", async () => {
    // Beginner summary: Paceman run-level isLive can go false; we still want the dot green if updates are recent.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));
    const nowSec = Math.floor(Date.now() / 1000);

    const paceman = {
      getRecentRunId: vi.fn().mockResolvedValue(999),
      getWorld: vi.fn().mockResolvedValue({
        isLive: false,
        data: {
          updateTime: nowSec - 60,
          insertTime: nowSec - 9999,
          nether: 123_000,
          bastion: 250_000,
        }, // updated 60s ago
      }),
    };

    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman,
    });

    const r = await withLocalServer(app, (r) => r.get("/status?names=xQcOW"));
    expect(r.status).toBe(200);
    expect(r.body.statuses.xQcOW.isLive).toBe(false);
    expect(r.body.statuses.xQcOW.isActive).toBe(true);
    expect(r.body.statuses.xQcOW.runIsActive).toBe(true);
    expect(r.body.statuses.xQcOW.lastMilestone).toBe("bastion");
  });

  // Test: GET /status surfaces a short Finish grace when a new run starts immediately
  it("GET /status surfaces a short Finish grace when a new run starts immediately", async () => {
    // Beginner summary: if a runner finishes and instantly starts a new run, we still want to show Finish briefly.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));
    const nowSec = Math.floor(Date.now() / 1000);

    const paceman = {
      getRecentRuns: vi.fn().mockResolvedValue([{ id: 200 }, { id: 199 }]),
      getWorld: vi.fn().mockImplementation(async (runId) => {
        if (runId === 200) {
          // New run: live, has end but no finish yet
          return {
            isLive: true,
            data: {
              updateTime: nowSec - 5,
              insertTime: nowSec - 60,
              end: 1_000_000,
            },
          };
        }
        if (runId === 199) {
          // Previous run: finished very recently
          return {
            isLive: false,
            data: {
              updateTime: nowSec - 65,
              insertTime: nowSec - 4000,
              finish: 1_200_000,
            },
          };
        }
        return { isLive: false, data: {} };
      }),
    };

    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman,
    });

    const r = await withLocalServer(app, (r) =>
      r.get("/status?names=Couriway")
    );
    expect(r.status).toBe(200);
    expect(r.body.statuses.Couriway.isActive).toBe(true);
    expect(r.body.statuses.Couriway.runIsActive).toBe(true);
    expect(r.body.statuses.Couriway.lastMilestone).toBe("end");
    expect(r.body.statuses.Couriway.recentFinishMs).toBe(1_200_000);
    expect(r.body.statuses.Couriway.recentFinishUpdatedSec).toBe(nowSec - 65);
  });

  // Test: GET /profiles returns twitch/uuid/avatarUrl per streamer
  it("GET /profiles returns twitch/uuid/avatarUrl per streamer", async () => {
    // Beginner summary: dashboard uses this endpoint to render streamer profile photos in tiles.
    const paceman = {
      getRecentRunId: vi.fn().mockResolvedValue(123),
      getWorld: vi.fn().mockResolvedValue({
        isLive: false,
        data: {
          twitch: "xqc",
          uuid: "37ee4401-5b10-48f1-bdd3-05037bef612f",
        },
      }),
    };

    const app = createApp({
      configPath,
      configDir,
      notifySend: vi.fn(async () => {}),
      paceman,
    });

    const r = await withLocalServer(app, (r) => r.get("/profiles?names=xQcOW"));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.profiles.xQcOW.twitch).toBe("xqc");
    expect(r.body.profiles.xQcOW.uuid).toBe(
      "37ee4401-5b10-48f1-bdd3-05037bef612f"
    );
    expect(r.body.profiles.xQcOW.avatarUrl).toMatch(
      /(unavatar\.io|static-cdn\.jtvnw\.net)/
    );
  });
});
