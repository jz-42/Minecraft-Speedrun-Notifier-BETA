// src/api/server.js (think this connects to frontend for milestone configuration)
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
function defaultIsAllowedOrigin(origin) {
  if (!origin) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

function createApp({
  configPath = path.join(__dirname, "../../config.json"),
  configDir = null,
  isAllowedOrigin = defaultIsAllowedOrigin,
  notifySend = require("../notify/router").send,
  paceman = require("../paceman/client"),
} = {}) {
  const app = express();
  app.use(express.json());
  const MAX_NAMES = 15; // keep consistent with dashboard /config max streamers

  const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || "";
  const SUPABASE_SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
  const SUPABASE_TABLE =
    process.env.SUPABASE_CONFIG_TABLE || "runalert_configs";

  // Very small in-memory cache for endpoints that proxy paceman.gg.
  // This keeps the dashboard from hammering paceman when it polls.
  const memCache = new Map(); // key -> { exp: number, value: any }
  function cacheGet(key) {
    const hit = memCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) {
      memCache.delete(key);
      return null;
    }
    return hit.value;
  }
  function cacheSet(key, value, ttlMs) {
    memCache.set(key, { exp: Date.now() + ttlMs, value });
  }

  const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
  const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";

  function normalizeTwitchHandle(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    let handle = raw;
    handle = handle.replace(/^https?:\/\//i, "");
    handle = handle.replace(/^www\./i, "");
    if (handle.toLowerCase().startsWith("twitch.tv/")) {
      handle = handle.slice("twitch.tv/".length);
    }
    handle = handle.replace(/^@/, "");
    handle = handle.split(/[/?#]/)[0];
    return handle ? handle.trim() : null;
  }

  async function getTwitchAppToken() {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
    const cached = cacheGet("twitchAppToken");
    if (cached?.token && typeof cached?.exp === "number") {
      // refresh a minute early
      if (Date.now() < cached.exp - 60_000) return cached.token;
    }

    try {
      const tokenUrl =
        "https://id.twitch.tv/oauth2/token" +
        `?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}` +
        `&client_secret=${encodeURIComponent(TWITCH_CLIENT_SECRET)}` +
        "&grant_type=client_credentials";
      const resp = await fetch(tokenUrl, { method: "POST" });
      if (!resp.ok) return null;
      const data = await resp.json();
      const token = data?.access_token;
      const expiresIn = Number(data?.expires_in) || 3600;
      if (!token) return null;
      cacheSet(
        "twitchAppToken",
        {
          token,
          exp: Date.now() + expiresIn * 1000,
        },
        expiresIn * 1000
      );
      return token;
    } catch {
      return null;
    }
  }

  async function fetchTwitchAvatarUrl(handle) {
    const normalized = normalizeTwitchHandle(handle);
    if (!normalized) return null;

    // Prefer official Helix when credentials are present.
    try {
      const appToken = await getTwitchAppToken();
      if (TWITCH_CLIENT_ID && appToken) {
        const helixUrl = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(
          normalized
        )}`;
        const helixResp = await fetch(helixUrl, {
          headers: {
            "Client-ID": TWITCH_CLIENT_ID,
            Authorization: `Bearer ${appToken}`,
          },
        });
        if (helixResp.ok) {
          const data = await helixResp.json();
          const profileImage = Array.isArray(data?.data)
            ? data.data?.[0]?.profile_image_url
            : null;
          if (typeof profileImage === "string" && profileImage.trim()) {
            return profileImage.trim();
          }
        }
      }
    } catch {
      // Best-effort only.
    }

    // Fallback: decapi (no-auth). Returns the avatar URL as plain text.
    try {
      const url = `https://decapi.me/twitch/avatar/${encodeURIComponent(
        normalized
      )}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "runalert-avatar" },
      });
      if (!resp.ok) return null;
      const text = (await resp.text()).trim();
      if (/^https?:\/\//i.test(text)) return text;
    } catch {
      // Best-effort only.
    }

    return null;
  }

  // Allow local dev frontends (Vite often bumps ports if 5173 is taken).
  // Keep this restricted to localhost / 127.0.0.1 for safety.
  app.use(
    cors({
      origin(origin, cb) {
        return cb(null, isAllowedOrigin(origin));
      },
    })
  );

  const resolvedConfigDir =
    configDir ||
    process.env.RUNALERT_CONFIG_DIR ||
    process.env.CONFIG_DIR ||
    path.join(path.dirname(configPath), "configs");

  function ensureConfigDir() {
    if (!resolvedConfigDir) return;
    if (!fs.existsSync(resolvedConfigDir)) {
      fs.mkdirSync(resolvedConfigDir, { recursive: true });
    }
  }

  function readConfigFromPath(targetPath) {
    const raw = fs.readFileSync(targetPath, "utf8");
    return JSON.parse(raw);
  }

  function writeConfigToPath(targetPath, next) {
    // pretty-print so it stays readable
    fs.writeFileSync(targetPath, JSON.stringify(next, null, 2) + "\n");
  }

  function readConfig() {
    return readConfigFromPath(configPath);
  }

  function writeConfig(next) {
    writeConfigToPath(configPath, next);
  }

  function getToken(req) {
    const raw = String(req.query?.token || "").trim();
    if (!raw) return null;
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) return null;
    return safe;
  }

  function getTokenConfigPath(token) {
    if (!token) return null;
    ensureConfigDir();
    if (!resolvedConfigDir) return null;
    return path.join(resolvedConfigDir, `${token}.json`);
  }

  function isSupabaseEnabled() {
    return String(process.env.RUNALERT_CONFIG_STORE || "")
      .trim()
      .toLowerCase() === "supabase";
  }

  function getSupabaseKey() {
    return SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  }

  async function supabaseFetch(path, options = {}) {
    if (typeof fetch !== "function") {
      throw new Error("global fetch is not available");
    }
    const key = getSupabaseKey();
    if (!SUPABASE_URL || !key) {
      throw new Error("Supabase env vars missing");
    }
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...options.headers,
    };
    return fetch(`${SUPABASE_URL}${path}`, { ...options, headers });
  }

  async function readConfigFromSupabase(token) {
    const safe = encodeURIComponent(token);
    const res = await supabaseFetch(
      `/rest/v1/${SUPABASE_TABLE}?token=eq.${safe}&select=config`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) {
      throw new Error(`Supabase GET config ${res.status}`);
    }
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length && rows[0]?.config) {
      return rows[0].config;
    }
    const base = readConfig();
    await writeConfigToSupabase(token, base);
    return base;
  }

  async function writeConfigToSupabase(token, next) {
    const payload = [
      {
        token,
        config: next,
        updated_at: new Date().toISOString(),
      },
    ];
    const res = await supabaseFetch(`/rest/v1/${SUPABASE_TABLE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Supabase upsert config ${res.status}`);
    }
  }

  async function readConfigForToken(token) {
    if (!token) return readConfig();
    if (isSupabaseEnabled()) {
      try {
        return await readConfigFromSupabase(token);
      } catch (e) {
        console.warn("[warn] supabase config read failed:", e?.message || e);
      }
    }
    const tokenPath = getTokenConfigPath(token);
    if (!tokenPath) return readConfig();
    if (fs.existsSync(tokenPath)) {
      return readConfigFromPath(tokenPath);
    }
    const base = readConfig();
    writeConfigToPath(tokenPath, base);
    return base;
  }

  async function writeConfigForToken(token, next) {
    if (!token) return writeConfig(next);
    if (isSupabaseEnabled()) {
      try {
        await writeConfigToSupabase(token, next);
        return;
      } catch (e) {
        console.warn("[warn] supabase config write failed:", e?.message || e);
      }
    }
    const tokenPath = getTokenConfigPath(token);
    if (!tokenPath) return writeConfig(next);
    writeConfigToPath(tokenPath, next);
  }

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/config", async (req, res) => {
    try {
      const token = getToken(req);
      res.json(await readConfigForToken(token));
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.put("/config", async (req, res) => {
    try {
      const next = req.body;
      const token = getToken(req);
      // minimal validation so you don't brick your file
      if (!next || typeof next !== "object") {
        return res.status(400).json({ error: "config must be an object" });
      }
      if (!Array.isArray(next.streamers)) {
        return res.status(400).json({ error: "streamers must be an array" });
      }
      if (next.streamers.length > MAX_NAMES) {
        return res
          .status(400)
          .json({ error: `too many streamers (max ${MAX_NAMES})` });
      }
      if (
        !next.defaultMilestones ||
        typeof next.defaultMilestones !== "object"
      ) {
        return res
          .status(400)
          .json({ error: "defaultMilestones must be an object" });
      }

      // Optional: validate quietHours shape so the watcher + dashboard stay consistent.
      // Supported:
      // - string: "HH:MM-HH:MM" (legacy)
      // - string[]: ["HH:MM-HH:MM", ...] (multi-span)
      if (
        next.quietHours != null &&
        typeof next.quietHours !== "string" &&
        !(
          Array.isArray(next.quietHours) &&
          next.quietHours.every((x) => typeof x === "string")
        )
      ) {
        return res.status(400).json({
          error: 'quietHours must be a string like "HH:MM-HH:MM" or an array of such strings',
        });
      }

      await writeConfigForToken(token, next);
      res.json({ ok: true, config: next });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Fetch paceman world + derive available milestone bases by inspecting data keys.
  app.get("/paceman/milestones", async (req, res) => {
    try {
      const name = String(req.query?.name || "").trim();
      if (!name) return res.status(400).json({ error: "name is required" });

      const runId = await paceman.getRecentRunId(name, 1);
      if (!runId) return res.json({ ok: true, runId: null, milestones: [] });

      const world = await paceman.getWorld(runId);
      const keys = Object.keys(world?.data || {});
      const bases = new Set();
      for (const k of keys) {
        if (k.endsWith("Rta")) bases.add(k.slice(0, -3));
        // IGT is stored in bare keys, so no "Igt" suffix in getWorld.
      }
      // Include any bare-key splits too
      for (const k of keys) {
        if (!k.endsWith("Rta") && !k.endsWith("Igt")) {
          // heuristic: split keys are lowercase with underscores; ignore metadata keys
          if (/^[a-z_]+$/.test(k)) bases.add(k);
        }
      }
      const milestones = Array.from(bases).sort((a, b) => a.localeCompare(b));
      res.json({ ok: true, runId, milestones });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Lightweight profile endpoint for streamer tiles (avatar sourcing).
  // Example: GET /profiles?names=xQcOW,forsen
  app.get("/profiles", async (req, res) => {
    try {
      const raw = String(req.query?.names || "").trim();
      if (!raw) return res.status(400).json({ error: "names is required" });

      const names = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!names.length)
        return res.status(400).json({ error: "names is required" });
      if (names.length > MAX_NAMES)
        return res
          .status(400)
          .json({ error: `too many names (max ${MAX_NAMES})` });

      const profiles = {};
      for (const name of names) {
        const key = `profile:${name.toLowerCase()}`;
        const cached = cacheGet(key);
        if (cached) {
          profiles[name] = cached;
          continue;
        }

        let runId = null;
        let twitch = null;
        let uuid = null;
        try {
          runId = await paceman.getRecentRunId(name, 1);
          if (runId) {
            const world = await paceman.getWorld(runId);
            twitch = normalizeTwitchHandle(world?.data?.twitch);
            uuid =
              typeof world?.data?.uuid === "string" && world.data.uuid.trim()
                ? world.data.uuid.trim()
                : null;
          }
        } catch {
          // best-effort
          runId = null;
          twitch = null;
          uuid = null;
        }

        // No-auth MVP: use public avatar services.
        // - Twitch profile image: prefer Helix/decapi, fall back to unavatar.
        // - Minecraft head: crafatar supports UUID heads.
        const twitchAvatarUrl = twitch
          ? await fetchTwitchAvatarUrl(twitch)
          : null;
        const avatarUrl =
          twitchAvatarUrl ||
          (twitch
            ? `https://unavatar.io/twitch/${encodeURIComponent(twitch)}`
            : uuid
              ? `https://crafatar.com/avatars/${encodeURIComponent(uuid)}?size=256&overlay`
              : null);

        const value = { runId, twitch, uuid, avatarUrl };
        // Cache hard: avatars don't change often.
        cacheSet(key, value, 6 * 60 * 60 * 1000);
        profiles[name] = value;
      }

      res.json({ ok: true, profiles });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Lightweight status endpoint for the dashboard streamer tiles.
  // Returns whether each streamer is "active" on Paceman recently, plus run-level isLive.
  // Also returns twitch-live state (best-effort) for UI indicators.
  // Example: GET /status?names=xQcOW,forsen
  app.get("/status", async (req, res) => {
    try {
      const raw = String(req.query?.names || "").trim();
      if (!raw) return res.status(400).json({ error: "names is required" });

      const names = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!names.length)
        return res.status(400).json({ error: "names is required" });
      if (names.length > MAX_NAMES)
        return res
          .status(400)
          .json({ error: `too many names (max ${MAX_NAMES})` });

      const statuses = {};
      const ACTIVE_WINDOW_SEC = 15 * 60; // "active on paceman" if updated within last 15 min
      const FINISH_GRACE_SEC = 2 * 60; // show Finish briefly even if a new run starts immediately
      const nowSec = Math.floor(Date.now() / 1000);

      // Keep in sync with dashboard's canonical milestones list.
      const CANONICAL_MILESTONES = [
        "nether",
        "bastion",
        "fortress",
        "first_portal",
        "stronghold",
        "end",
        "finish",
      ];
      const LIVE_EVENT_BY_MILESTONE = {
        nether: "rsg.enter_nether",
        bastion: "rsg.enter_bastion",
        fortress: "rsg.enter_fortress",
        first_portal: "rsg.first_portal",
        stronghold: "rsg.enter_stronghold",
        end: "rsg.enter_end",
        finish: "rsg.credits",
      };

      function getSplitMsFromWorldData(world, base) {
        const data = world?.data || {};
        const candidates = [
          data?.[base],
          data?.[`${base}Igt`],
          data?.[`${base}Rta`],
        ];
        for (const v of candidates) {
          if (Number.isFinite(v) && v >= 0) return v;
        }
        return null;
      }

      function getLiveSplitMs(liveRun, milestone) {
        const eventId = LIVE_EVENT_BY_MILESTONE[milestone];
        if (!eventId) return null;
        const event = liveRun?.eventList?.find((e) => e?.eventId === eventId);
        if (!event) return null;
        const candidates = [event?.igt, event?.rta];
        for (const v of candidates) {
          if (Number.isFinite(v) && v >= 0) return v;
        }
        return null;
      }

      function getWorldSplitMsForClock(world, milestone, clock) {
        const data = world?.data || {};
        if (clock === "IGT") {
          const v = data?.[milestone];
          return Number.isFinite(v) && v >= 0 ? v : null;
        }
        if (clock === "RTA") {
          const v = data?.[`${milestone}Rta`];
          return Number.isFinite(v) && v >= 0 ? v : null;
        }
        return null;
      }

      function getLiveSplitMsForClock(liveRun, milestone, clock) {
        const eventId = LIVE_EVENT_BY_MILESTONE[milestone];
        if (!eventId) return null;
        const event = liveRun?.eventList?.find((e) => e?.eventId === eventId);
        if (!event) return null;
        if (clock === "IGT") {
          return Number.isFinite(event?.igt) && event.igt >= 0
            ? event.igt
            : null;
        }
        if (clock === "RTA") {
          return Number.isFinite(event?.rta) && event.rta >= 0
            ? event.rta
            : null;
        }
        return null;
      }

      function getSplitMsForClock(world, liveRun, milestone, clock) {
        const worldMs = getWorldSplitMsForClock(world, milestone, clock);
        if (worldMs != null) return worldMs;
        return getLiveSplitMsForClock(liveRun, milestone, clock);
      }

      function normalizeNick(value) {
        return String(value || "").trim().toLowerCase();
      }

      function toNameList(value) {
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
      }

      function findLiveRunForStreamer(liveRuns, names) {
        const targets = new Set(
          toNameList(names).map(normalizeNick).filter(Boolean)
        );
        if (!targets.size) return null;
        return (
          (liveRuns || []).find((run) => {
            const nick = normalizeNick(
              run?.nickname ||
                run?.user?.nickname ||
                run?.user?.nick ||
                run?.user?.displayName
            );
            return nick && targets.has(nick);
          }) || null
        );
      }

      function normalizeUpdatedSec(value) {
        if (!Number.isFinite(value) || value <= 0) return null;
        // Paceman live runs can return ms; normalize to seconds.
        return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
      }

      function getLastMilestone(world, liveRun) {
        let lastMilestone = null;
        let lastMilestoneMs = null;
        let lastMilestoneSource = null;
        for (const m of CANONICAL_MILESTONES) {
          const worldMs = getSplitMsFromWorldData(world, m);
          const liveMs = getLiveSplitMs(liveRun, m);
          const ms = worldMs ?? liveMs;
          if (ms != null && (lastMilestoneMs == null || ms >= lastMilestoneMs)) {
            lastMilestone = m;
            lastMilestoneMs = ms;
            lastMilestoneSource = worldMs != null ? "world" : "live";
          }
        }
        return { lastMilestone, lastMilestoneMs, lastMilestoneSource };
      }

      let liveRuns = null;
      if (typeof paceman.getLiveRuns === "function") {
        try {
          liveRuns = await paceman.getLiveRuns();
        } catch (_e) {
          liveRuns = null;
        }
      }

      async function fetchTwitchLive(handle) {
        const raw = String(handle || "").trim();
        if (!raw) return null;
        const cacheKey = `twitchLive:${raw.toLowerCase()}`;
        const cached = cacheGet(cacheKey);
        if (typeof cached === "boolean") return cached;

        try {
          const appToken = await getTwitchAppToken();
          if (TWITCH_CLIENT_ID && appToken) {
            const helixUrl = `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(
              raw
            )}`;
            const helixResp = await fetch(helixUrl, {
              headers: {
                "Client-ID": TWITCH_CLIENT_ID,
                Authorization: `Bearer ${appToken}`,
              },
            });
            if (helixResp.ok) {
              const data = await helixResp.json();
              const isLive =
                Array.isArray(data?.data) && data.data.length > 0;
              cacheSet(cacheKey, isLive, 60_000);
              return isLive;
            }
          }

          // Fallback: decapi (no-auth). Best-effort only.
          const url = `https://decapi.me/twitch/stream/${encodeURIComponent(
            raw
          )}`;
          const resp = await fetch(url, {
            headers: { "User-Agent": "runalert-status" },
          });
          const text = await resp.text();
          if (!resp.ok) return null;
          const normalized = text.trim().toLowerCase();
          const isOffline =
            normalized.includes("offline") ||
            normalized.includes("not live") ||
            normalized.includes("not online");
          const isLive = !isOffline && normalized.length > 0;
          cacheSet(cacheKey, isLive, 60_000);
          return isLive;
        } catch {
          return null;
        }
      }

      for (const name of names) {
        const key = `status:${name.toLowerCase()}`;
        const cached = cacheGet(key);
        if (cached) {
          statuses[name] = cached;
          continue;
        }

        let runId = null;
        let prevRunId = null;
        let isLive = false;
        let isActive = false;
        let runIsActive = false;
        let lastUpdatedSec = null;
        let runStartSec = null;
        let lastMilestone = null;
        let lastMilestoneMs = null;
        let lastMilestoneSource = null;
        let recentFinishUpdatedSec = null;
        let recentFinishMs = null;
        let splits = null;
        let twitchLive = null;
        let twitchHandle = null;
        try {
          if (typeof paceman.getRecentRuns === "function") {
            const runs = await paceman.getRecentRuns(name, 2);
            runId = runs?.[0]?.id ?? null;
            prevRunId = runs?.[1]?.id ?? null;
          } else {
            runId = await paceman.getRecentRunId(name, 1);
          }
          if (runId) {
            const world = await paceman.getWorld(runId);
            const rawTwitch =
              typeof world?.data?.twitch === "string" &&
              world.data.twitch.trim()
                ? world.data.twitch.trim()
                : null;
            twitchHandle = normalizeTwitchHandle(rawTwitch);
            isLive = !!world?.isLive;
            // Paceman's isLive is run-level ("in liveruns") and can go false even while a runner is still playing.
            // For a more human-friendly "active" signal, we treat "recently updated" as active.
            lastUpdatedSec =
              (Number.isFinite(world?.data?.updateTime) &&
              world?.data?.updateTime > 0
                ? world.data.updateTime
                : null) ?? null;
            runStartSec =
              (Number.isFinite(world?.data?.insertTime) &&
              world?.data?.insertTime > 0
                ? world.data.insertTime
                : null) ?? null;
            isActive =
              isLive ||
              (typeof lastUpdatedSec === "number" &&
                nowSec - lastUpdatedSec <= ACTIVE_WINDOW_SEC);
            // For now, keep runIsActive identical to isActive (no additional "freshness" suppression).
            runIsActive = isActive;

            const liveRun = findLiveRunForStreamer(liveRuns, [
              name,
              world?.data?.nickname,
              world?.data?.twitch,
              twitchHandle,
            ]);
            if (liveRun) {
              isLive = true;
              isActive = true;
              runIsActive = true;
            }

            const last = getLastMilestone(world, liveRun);
            lastMilestone = last.lastMilestone;
            lastMilestoneMs = last.lastMilestoneMs;
            lastMilestoneSource = last.lastMilestoneSource;
            const splitMap = {};
            for (const m of CANONICAL_MILESTONES) {
              splitMap[m] = {
                igt: getSplitMsForClock(world, liveRun, m, "IGT"),
                rta: getSplitMsForClock(world, liveRun, m, "RTA"),
              };
            }
            splits = splitMap;
            if (lastMilestoneSource === "live") {
              const liveUpdatedSec = normalizeUpdatedSec(liveRun?.lastUpdated);
              if (liveUpdatedSec != null) lastUpdatedSec = liveUpdatedSec;
            }

            // If they finished and instantly started a new run, the latest run won't have "finish".
            // In that case, surface a brief "recentFinish" signal from the previous run.
            if (lastMilestone !== "finish" && prevRunId) {
              const prevWorld = await paceman.getWorld(prevRunId);
              const prevFinishMs = getSplitMsFromWorldData(prevWorld, "finish");
              const prevUpdatedSec =
                Number.isFinite(prevWorld?.data?.updateTime) &&
                prevWorld.data.updateTime > 0
                  ? prevWorld.data.updateTime
                  : null;
              if (
                prevFinishMs != null &&
                typeof prevUpdatedSec === "number" &&
                nowSec - prevUpdatedSec <= FINISH_GRACE_SEC
              ) {
                recentFinishMs = prevFinishMs;
                recentFinishUpdatedSec = prevUpdatedSec;
              }
            }
          }
          const handleForLive = twitchHandle || name;
          twitchLive = await fetchTwitchLive(handleForLive);
        } catch (e) {
          // Per-name failures should not break the entire response.
          runId = null;
          isLive = false;
          isActive = false;
          runIsActive = false;
          lastUpdatedSec = null;
          runStartSec = null;
          lastMilestone = null;
          lastMilestoneMs = null;
          lastMilestoneSource = null;
          recentFinishUpdatedSec = null;
          recentFinishMs = null;
          splits = null;
          twitchLive = null;
        }

        const value = {
          runId,
          isLive,
          isActive,
          runIsActive,
          isTwitchLive: twitchLive === true,
          twitch: twitchHandle,
          lastUpdatedSec,
          runStartSec,
          lastMilestone,
          lastMilestoneMs,
          lastMilestoneSource,
          splits,
          recentFinishMs,
          recentFinishUpdatedSec,
        };
        // Keep roughly in sync with the dashboard polling interval so UI updates feel live.
        cacheSet(key, value, 5_000);
        statuses[name] = value;
      }

      res.json({ ok: true, statuses });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Simple “is desktop notifications wired up?” endpoint.
  app.post("/notify/test", async (req, res) => {
    try {
      const title = String(req.body?.title || "runAlert test");
      const message = String(
        req.body?.message || "Desktop notifications are working."
      );
      await notifySend({ channel: "desktop", title, message });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/install/macos.command", (req, res) => {
    const host = req.get("host");
    if (!host) return res.status(400).send("Missing host header.");
    const proto = req.get("x-forwarded-proto") || req.protocol || "https";
    const baseUrl = `${proto}://${host}`;
    const token = getToken(req);
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
    const repoUrl = process.env.AGENT_REPO_URL || "";
    const script = `#!/bin/bash
set -euo pipefail

REMOTE_CONFIG_URL="${baseUrl}/config${tokenQuery}"
RUNALERT_DIR="\${RUNALERT_DIR:-$HOME/runAlert}"
REPO_URL="${repoUrl}"

echo "runAlert installer (macOS)"
echo "Using config: $REMOTE_CONFIG_URL"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install from https://nodejs.org/ and re-run this installer."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required. Install Xcode Command Line Tools with: xcode-select --install"
  exit 1
fi

if [ ! -d "$RUNALERT_DIR" ]; then
  if [ -z "$REPO_URL" ]; then
    echo "Missing repo URL. Ask the project owner to set AGENT_REPO_URL on the server."
    echo "Then re-download this installer."
    exit 1
  fi
  echo "Downloading runAlert to $RUNALERT_DIR..."
  git clone "$REPO_URL" "$RUNALERT_DIR"
fi

cd "$RUNALERT_DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --production
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "Installing pm2..."
  npm install -g pm2
fi

echo "Starting background agent..."
if pm2 describe runalert-watcher >/dev/null 2>&1; then
  REMOTE_CONFIG_URL="$REMOTE_CONFIG_URL" pm2 restart runalert-watcher --update-env
else
  REMOTE_CONFIG_URL="$REMOTE_CONFIG_URL" pm2 start src/watcher/run_watcher.js --name runalert-watcher --update-env
fi
pm2 save

echo "Enabling auto-start on login..."
startup_output="$(pm2 startup launchd -u "$USER" --hp "$HOME" 2>&1 || true)"
if [ -n "$startup_output" ]; then
  echo "$startup_output"
fi
if echo "$startup_output" | grep -q "sudo"; then
  echo "Auto-start requires sudo. Run the command above."
fi

echo "✅ runAlert agent installed."
echo "You can close this window. Notifications will run in the background."
`;

    if (String(req.query?.view || "").trim() === "1") {
      res.setHeader(
        "Content-Disposition",
        'inline; filename="runalert-install.command"'
      );
    } else {
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="runalert-install.command"'
      );
    }
    res.type("text/plain").send(script);
  });

  const dashboardDist = path.join(__dirname, "../../dashboard/dist");
  const dashboardIndex = path.join(dashboardDist, "index.html");
  if (fs.existsSync(dashboardIndex)) {
    app.use(express.static(dashboardDist));
    app.get("*", (_req, res) => {
      res.sendFile(dashboardIndex);
    });
  }

  return app;
}

function startServer(port = 8787) {
  const resolvedPort = (() => {
    const envPort = Number.parseInt(process.env.PORT || "", 10);
    if (Number.isFinite(envPort) && envPort > 0) return envPort;
    return port;
  })();
  const app = createApp();
  app.listen(resolvedPort, () => {
    console.log(`[api] listening on http://localhost:${resolvedPort}`);
  });
}

module.exports = { createApp, startServer, defaultIsAllowedOrigin };
