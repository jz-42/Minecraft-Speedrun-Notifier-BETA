// alert_poll_loop.js — continuously watches streamer(s), monitoring if there was a new run.

// if there was a new run, continuously watch that run for a new milestone time
// if there was a new milestone time, compare it to our threshold
// if the threshold is reached, send a notification
// * NOTE - both loops run at the sime time, the streamer(s) new run poller AND the inner milestone time poller

const { startServer } = require("../api/server"); // start the server on port 8787

const { send } = require("../notify/router");
const { markIfNew } = require("../store/dedupe_store"); // imports func. from store.js
const {
  getRecentRunId,
  getWorld,
  getSplitMs,
  getLiveRuns,
} = require("../paceman/client"); // imports API functions

const fs = require("fs");
const path = require("path");
const CONFIG_PATH = path.join(__dirname, "../../config.json");
const REMOTE_CONFIG_URL = (process.env.REMOTE_CONFIG_URL || "").trim();
const REMOTE_CONFIG_POLL_MS =
  Number(process.env.REMOTE_CONFIG_POLL_MS) || 5_000;
let remoteConfig = null;
let remoteConfigUpdatedAt = null;

function loadCfg() {
  if (REMOTE_CONFIG_URL && remoteConfig) {
    return remoteConfig;
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

function buildMilestones(cfg) {
  const STREAMERS = cfg.streamers?.length ? cfg.streamers : ["xQcOW"];
  const DEFAULT_MILESTONES = cfg.defaultMilestones || {
    nether: { thresholdSec: 240, enabled: true },
  };

  const STREAMER_MILESTONES = Object.fromEntries(
    STREAMERS.map((name) => {
      const profile = cfg.profiles?.[name] || {};
      // Include milestones that exist only in the profile (not in defaults).
      // This is required so per-streamer milestones like "bastion" can be watched.
      const keys = new Set([
        ...Object.keys(DEFAULT_MILESTONES),
        ...Object.keys(profile),
      ]);

      const merged = Object.fromEntries(
        Array.from(keys).map((milestone) => {
          const base = DEFAULT_MILESTONES[milestone] || {};
          const override = profile[milestone] || {};
          return [milestone, { ...base, ...override }];
        })
      );
      return [name, merged];
    })
  );

  return { STREAMERS, DEFAULT_MILESTONES, STREAMER_MILESTONES };
}

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);
function parseBool(val, def = false) {
  if (val === undefined) return def;
  if (val === true) return true;
  if (val === false) return false;
  const s = String(val).toLowerCase();
  return !(s === "0" || s === "false" || s === "no" || s === "off");
}
const DEBUG = parseBool(argv.debug, true);
const DRY_RUN = parseBool(argv["dry-run"], false); // ← respects "=false"
const ONCE = parseBool(argv["once"], false);
const FORCE_SEND = parseBool(argv["force"], false);
const OVERRIDE_QUIET = parseBool(argv["no-quiet"], false);

const POLL_RECENT_MS = 20_000; // how often to check for new run IDs
const POLL_WORLD_MS = 5_000; // how often to check on an active run
const POST_RUN_GRACE_MS = 2 * 60_000; // allow late split updates after a run ends

const {
  msToMMSS,
  milestonePrettyLabel,
  milestoneEnteredLabel,
  milestoneEmoji,
  formatNotificationTitle,
} = require("./notification_format");

async function fetchRemoteConfigOnce() {
  if (!REMOTE_CONFIG_URL) return false;
  if (typeof fetch !== "function") {
    console.warn(
      "[warn] REMOTE_CONFIG_URL set but global fetch is unavailable; using local config.json"
    );
    return false;
  }

  try {
    const res = await fetch(REMOTE_CONFIG_URL);
    if (!res.ok) {
      throw new Error(`GET ${REMOTE_CONFIG_URL} ${res.status}`);
    }
    const json = await res.json();
    if (!json || typeof json !== "object") {
      throw new Error("remote config JSON is not an object");
    }
    remoteConfig = json;
    remoteConfigUpdatedAt = Date.now();
    if (DEBUG) {
      console.log(
        "[config] remote config synced",
        new Date(remoteConfigUpdatedAt).toISOString()
      );
    }
    return true;
  } catch (e) {
    console.warn("[warn] remote config fetch failed:", e?.message || e);
    return false;
  }
}

function validateConfig(cfg, STREAMERS, DEFAULT_MILESTONES) {
  let ok = true;

  const profiles = cfg.profiles || {};

  // 1) Profiles for unknown streamers
  for (const name of Object.keys(profiles)) {
    if (!STREAMERS.includes(name)) {
      ok = false;
      console.warn(
        "[warn] config.profiles has an entry for streamer",
        `"${name}"`,
        "which is not listed in config.streamers"
      );
    }
  }

  // 2) Profile milestones that don't exist in defaults
  for (const [name, profile] of Object.entries(profiles)) {
    for (const milestone of Object.keys(profile)) {
      if (!DEFAULT_MILESTONES[milestone]) {
        ok = false;
        console.warn(
          "[warn] config.profiles.",
          name,
          "refers to unknown milestone",
          `"${milestone}"`,
          "(no defaultMilestones entry)"
        );
      }
    }
  }

  return ok;
}

function isRunLive(world) {
  return !!world?.isLive;
}

function getSplitWithClock(world, milestone, primaryClock, fallbackClock) {
  let usedClock = primaryClock;
  let ms = getSplitMs(world, milestone, usedClock);
  if (ms == null) {
    ms = getSplitMs(world, milestone, fallbackClock);
    if (ms != null) usedClock = fallbackClock;
  }
  return { ms, usedClock };
}

const LIVE_EVENT_BY_MILESTONE = {
  nether: "rsg.enter_nether",
  bastion: "rsg.enter_bastion",
  fortress: "rsg.enter_fortress",
  first_portal: "rsg.first_portal",
  second_portal: "rsg.second_portal",
  stronghold: "rsg.enter_stronghold",
  end: "rsg.enter_end",
  finish: "rsg.credits",
};

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

function getLiveSplitMs(liveRun, milestone, clock) {
  if (!liveRun) return null;
  const eventId = LIVE_EVENT_BY_MILESTONE[milestone];
  if (!eventId) return null;
  const event = liveRun?.eventList?.find((e) => e?.eventId === eventId);
  if (!event) return null;
  const key = String(clock || "").toLowerCase();
  const ms = event?.[key];
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function getSplitWithLiveFallback(
  world,
  liveRun,
  milestone,
  primaryClock,
  fallbackClock
) {
  const primary = getSplitMs(world, milestone, primaryClock);
  if (primary != null) {
    return { ms: primary, usedClock: primaryClock, source: "world" };
  }
  const fallback = getSplitMs(world, milestone, fallbackClock);
  if (fallback != null) {
    return { ms: fallback, usedClock: fallbackClock, source: "world" };
  }
  const livePrimary = getLiveSplitMs(liveRun, milestone, primaryClock);
  if (livePrimary != null) {
    return { ms: livePrimary, usedClock: primaryClock, source: "live" };
  }
  const liveFallback = getLiveSplitMs(liveRun, milestone, fallbackClock);
  if (liveFallback != null) {
    return { ms: liveFallback, usedClock: fallbackClock, source: "live" };
  }
  return { ms: null, usedClock: primaryClock, source: null };
}

// Core alert contract (exported for tests):
// - If split exists (ms != null)
// - and milestone is enabled
// - and (forceSend || splitSeconds < thresholdSec)
// → should notify.
function shouldNotifyMilestone({
  ms,
  enabled = true,
  thresholdSec = 999999,
  forceSend = false,
}) {
  if (!enabled) return false;
  if (ms == null) return false;
  const sec = Math.floor(ms / 1000);
  return forceSend || sec < thresholdSec;
}

function printConfigSummary(
  cfg,
  STREAMERS,
  DEFAULT_MILESTONES,
  STREAMER_MILESTONES
) {
  if (!DEBUG) return;

  console.log("[config] streamers:", STREAMERS.join(", "));
  console.log("[config] default milestones:");
  for (const [m, o] of Object.entries(DEFAULT_MILESTONES)) {
    const enabled = o.enabled ?? true;
    console.log(
      "  -",
      m,
      enabled ? "(on)" : "(off)",
      "| cutoff:",
      (o.thresholdSec ?? "∞") + "s"
    );
  }

  console.log("[config] profiles:");
  const profiles = cfg.profiles || {};
  for (const name of STREAMERS) {
    const milestonesForStreamer =
      STREAMER_MILESTONES[name] || DEFAULT_MILESTONES;
    const parts = Object.entries(milestonesForStreamer).map(
      ([milestone, cfgMilestone]) => {
        const enabled = cfgMilestone.enabled ?? true;
        const cutoff = cfgMilestone.thresholdSec ?? "∞";
        return `${enabled ? "" : "!"}${milestone}<${cutoff}s`;
      }
    );
    console.log("  -", name, "→", parts.join(", "));
  }

  for (const name of Object.keys(profiles)) {
    if (!STREAMERS.includes(name)) {
      console.log("  - (ignored profile for unknown streamer:", name + ")");
    }
  }
}

function getClocks() {
  const cfg = loadCfg();
  const primary = (cfg.clock || "IGT").toUpperCase();
  const fallback = primary === "IGT" ? "RTA" : "IGT";
  return { primary, fallback };
}

function parseHHMMToMinutes(s) {
  // Parse "HH:MM" in 24-hour time into minutes since midnight.
  // Returns number in [0, 1439] or null if invalid.
  if (typeof s !== "string") return null;
  const raw = s.trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function isTimeInQuietRange(range, now = new Date()) {
  // Returns true if `now` falls within the range "HH:MM-HH:MM".
  // Semantics: start inclusive, end exclusive.
  if (typeof range !== "string") return false;
  const parts = range.split("-");
  if (parts.length !== 2) return false;
  const a = parseHHMMToMinutes(parts[0]);
  const b = parseHHMMToMinutes(parts[1]);
  if (a == null || b == null) return false;

  const cur = now.getHours() * 60 + now.getMinutes();
  // Normal range: a <= cur < b
  // Wrap-around: cur >= a OR cur < b
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

function inQuietHours(quietHours, now = new Date()) {
  // Returns true if `now` is inside any configured quiet-hours range.
  // Supported config shapes:
  // - string: "HH:MM-HH:MM" (legacy)
  // - string[]: ["HH:MM-HH:MM", ...] (multi-span)
  if (!quietHours || OVERRIDE_QUIET) return false;
  if (Array.isArray(quietHours)) {
    return quietHours.some((r) => isTimeInQuietRange(r, now));
  }
  return isTimeInQuietRange(quietHours, now);
}

// return a status so caller can log accurately
async function sendNotify(title, message, opts = {}) {
  if (DRY_RUN) {
    if (DEBUG) console.log("[dry-run] would notify:", title, message);
    return "dry-run";
  }

  const cfg = loadCfg();
  if (inQuietHours(cfg.quietHours) && !OVERRIDE_QUIET) {
    if (DEBUG)
      console.log(
        "[debug] notification suppressed by quiet hours:",
        cfg.quietHours
      );
    return "quiet";
  }
  await send({ channel: "desktop", title, message, ...opts });
  return "sent";
}

async function alertOnce({
  streamer,
  runId,
  milestone,
  usedClock,
  splitMs,
  twitchName,
}) {
  // takes streamer name, run id, clock type, and milestone time in Ms and calls sendDM to send discord dm.

  const sec = Math.floor(splitMs / 1000); // convert to seconds
  // Dedupe should be "one alert per milestone per run" (avoid spam if clock/threshold changes).
  // Keep legacy key too so existing sent_keys.json entries still suppress duplicates.
  const key = `${milestone}|${streamer}|${runId}`;
  const legacyKey = `${milestone}|${usedClock}|${streamer}|${runId}|${sec}`;
  if (!markIfNew([key, legacyKey])) {
    // returns if already sent
    if (DEBUG) console.log("[debug] dedupe: already alerted", key);
    return;
  }
  const title = formatNotificationTitle({
    milestone,
    splitMs,
    streamer,
  });
  // Keep message secondary (notification banner is primarily the title).
  const message = `Run ${runId}`;

  const twitch = (twitchName || streamer || "").trim();
  const openUrl = twitch
    ? `https://www.twitch.tv/${encodeURIComponent(twitch)}`
    : undefined;

  const status = await sendNotify(title, message, {
    openUrl,
    actions: openUrl ? ["Open Stream"] : undefined,
    // Try to keep it around; OS settings may still auto-dismiss banners.
    timeout: 0,
    wait: true,
  });
  if (status === "sent") {
    console.log("[NOTIFY]", title, message);
  } else {
    console.log("[NOTIFY-SKIPPED:%s]", status, title, message);
  }
}

// takes streamer (just one) + runId, ONLY loops and watches ONE RUN, alerting if time < threshold
// breaks when streamer offline
async function watchRun(streamer, runId) {
  if (DEBUG) console.log(`[debug] watching run ${runId} for ${streamer}`);

  let active = true;
  let wasLive = false;
  let postRunUntil = null;
  while (active) {
    const cfg = loadCfg();
    // If streamer was removed from config, stop watching.
    if (Array.isArray(cfg.streamers) && !cfg.streamers.includes(streamer)) {
      if (DEBUG)
        console.log(
          "[debug] streamer removed from config; stop watching",
          streamer
        );
      break;
    }
    const { primary: PRIMARY_CLOCK, fallback: FALLBACK_CLOCK } = getClocks();

    const { DEFAULT_MILESTONES, STREAMER_MILESTONES } = buildMilestones(cfg);
    const milestonesForStreamer =
      STREAMER_MILESTONES[streamer] || DEFAULT_MILESTONES;

    try {
      // catch error
      const world = await getWorld(runId); // get json
      if (!world) {
        if (DEBUG) console.log("[debug] world missing; stopping:", runId);
        break;
      }
      const isLive = !!world?.isLive; // if world exists and if live, coerce to bool
      wasLive = wasLive || isLive;

      // Important product behavior: only alert for runs that are actually live.
      // If the most recent run is already finished, don't spam notifications on startup.
      if (!wasLive) {
        if (DEBUG)
          console.log("[debug] run is not live; skipping alerts", runId);
        break;
      }

      let liveRun = null;
      if (isLive) {
        try {
          const liveRuns = await getLiveRuns();
          liveRun = findLiveRunForStreamer(liveRuns, [
            streamer,
            world?.data?.nickname,
            world?.data?.twitch,
          ]);
        } catch (e) {
          if (DEBUG)
            console.log("[debug] live runs unavailable:", e?.message || e);
        }
      }

      // ***
      for (const [milestone] of Object.entries(milestonesForStreamer)) {
        const { ms: sample, source } = getSplitWithLiveFallback(
          world,
          liveRun,
          milestone,
          PRIMARY_CLOCK,
          FALLBACK_CLOCK
        );
        if (DEBUG)
          console.log(
            "[debug]",
            streamer,
            milestone,
            "≈",
            `${msToMMSS(sample ?? null)}${source ? ` (${source})` : ""}`
          );
      }
      // ***

      if (DEBUG) {
        console.log("[debug]", streamer, "isLive:", isLive);
      }

      // ***
      let missingEnabledSplit = false;
      for (const [milestone, cfgMilestone] of Object.entries(
        milestonesForStreamer
      )) {
        const { thresholdSec = 999999, enabled = true } = cfgMilestone;
        if (!enabled) {
          if (DEBUG)
            console.log(
              "[debug]",
              streamer,
              milestone,
              "disabled for this streamer"
            );
          continue;
        }

        const { ms, usedClock } = getSplitWithLiveFallback(
          world,
          liveRun,
          milestone,
          PRIMARY_CLOCK,
          FALLBACK_CLOCK
        );
        if (ms == null) {
          missingEnabledSplit = true;
          continue;
        }

        if (
          shouldNotifyMilestone({
            ms,
            enabled,
            thresholdSec,
            forceSend: FORCE_SEND,
          })
        ) {
          await alertOnce({
            streamer,
            runId,
            milestone,
            usedClock,
            splitMs: ms,
            twitchName: world?.data?.twitch || world?.data?.nickname,
          });
        } else if (DEBUG) {
          const sec = Math.floor(ms / 1000);
          console.log(
            `[debug] ${milestone} ${usedClock} ${sec}s >= cutoff ${thresholdSec}s — not sending`
          );
        }
      }

      // ***

      // break loop if streamer offline (with brief grace for late splits)
      if (!isLive) {
        if (postRunUntil == null) {
          postRunUntil = Date.now() + POST_RUN_GRACE_MS;
          if (DEBUG)
            console.log(
              "[debug] run ended; waiting for late splits",
              runId,
              `(grace ${Math.round(POST_RUN_GRACE_MS / 1000)}s)`
            );
        }
        if (!missingEnabledSplit || Date.now() >= postRunUntil) {
          if (DEBUG) console.log("[debug] run ended, stop watching", runId);
          active = false;
        }
      } else {
        postRunUntil = null;
      }
    } catch (e) {
      console.error("[error] watchRun", e?.message || e);
      active = false;
    }
    if (active) await new Promise((r) => setTimeout(r, POLL_WORLD_MS));
  }
}

// loops over ONE STREAMER, get id and if it's valid + not repeated, call loop within one run id
async function loopStreamer(streamer, isActive = () => true) {
  let lastRunId = null;
  while (isActive()) {
    try {
      // get streamer's recent run_id
      const id = await getRecentRunId(streamer);
      if (DEBUG) console.log("[debug] recentRunId for", streamer, "=>", id);

      // if exists and not last run id
      if (id && id !== lastRunId) {
        lastRunId = id;
        // Only watch if it's actually live (prevents notifications for dead runs).
        const world = await getWorld(id);
        const isLive = !!world?.isLive;
        if (!isLive) {
          if (DEBUG)
            console.log(
              "[debug] most recent run is not live; skipping",
              streamer,
              id
            );
          continue;
        }
        // loop within a loop - watch streamer, (watch run loop within)
        watchRun(streamer, id); // don’t await, run concurrently
        if (ONCE) return; // single iteration mode for testing
      }
    } catch (e) {
      console.error("[error] loopStreamer", streamer, e?.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_RECENT_MS)); // delay run loop by x seconds
  }
}

async function main() {
  if (REMOTE_CONFIG_URL) {
    if (DEBUG) {
      console.log("[config] using remote config:", REMOTE_CONFIG_URL);
    }
    await fetchRemoteConfigOnce();
    setInterval(fetchRemoteConfigOnce, REMOTE_CONFIG_POLL_MS);
  }

  const cfg = loadCfg();
  const { STREAMERS, DEFAULT_MILESTONES, STREAMER_MILESTONES } =
    buildMilestones(cfg);

  const cfgOk = validateConfig(cfg, STREAMERS, DEFAULT_MILESTONES);
  if (!cfgOk) {
    console.warn(
      "[warn] Some config issues were detected; see warnings above. Continuing anyway."
    );
  }

  const { primary: PRIMARY_CLOCK, fallback: FALLBACK_CLOCK } = getClocks();

  console.log(
    "Looping poller:",
    STREAMERS.join(", "),
    "| Milestones:",
    Object.entries(DEFAULT_MILESTONES)
      .map(([m, o]) => `${m}<${o.thresholdSec ?? "∞"}s`)
      .join(", "),
    "| CLOCK:",
    PRIMARY_CLOCK,
    "fallback:",
    FALLBACK_CLOCK,
    "| DEBUG:",
    DEBUG,
    "| DRY_RUN:",
    DRY_RUN,
    "| ONCE:",
    ONCE,
    "| FORCE_SEND:",
    FORCE_SEND,
    "| OVERRIDE_QUIET:",
    OVERRIDE_QUIET
  );

  printConfigSummary(cfg, STREAMERS, DEFAULT_MILESTONES, STREAMER_MILESTONES);

  // Manage streamer loops dynamically based on config.json.
  // This allows the dashboard to add/remove streamers without restarting the watcher.
  const activeLoops = new Map(); // name -> { active: boolean }

  function ensureLoop(name) {
    if (activeLoops.has(name)) return;
    const state = { active: true };
    activeLoops.set(name, state);
    if (DEBUG) console.log("[debug] starting loopStreamer for", name);
    loopStreamer(name, () => state.active);
  }

  function syncStreamers() {
    const nextCfg = loadCfg();
    const names = Array.isArray(nextCfg.streamers) ? nextCfg.streamers : [];

    // Start any newly-added streamers
    for (const n of names) ensureLoop(n);

    // Stop loops for removed streamers
    for (const [name, state] of activeLoops.entries()) {
      if (!names.includes(name)) {
        if (DEBUG) console.log("[debug] stopping loopStreamer for", name);
        state.active = false;
        activeLoops.delete(name);
      }
    }
  }

  syncStreamers();
  setInterval(syncStreamers, 5_000);
}

// Heartbeat so we know it's alive, i think it's outside of all funcs and the main, it just somehow loops and beats every minute
function startHeartbeat() {
  setInterval(
    () => console.log("[heartbeat]", new Date().toISOString()),
    60_000
  );
}

if (require.main === module) {
  // Only load .env in real runtime, not when imported by tests.
  require("dotenv").config();
  startServer();
  main();
  startHeartbeat();
}

module.exports = {
  buildMilestones,
  inQuietHours,
  isTimeInQuietRange,
  isRunLive,
  getSplitWithClock,
  getLiveSplitMs,
  findLiveRunForStreamer,
  getSplitWithLiveFallback,
  shouldNotifyMilestone,
  // Exported for tests + other modules that want consistent formatting.
  msToMMSS,
  milestonePrettyLabel,
  milestoneEnteredLabel,
  milestoneEmoji,
  formatNotificationTitle,
};
