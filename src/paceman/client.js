// client.js - our file that lets us interact with paceman api. formerly paceman_api.js

// FUNCTIONS
// 1. getRecentRunId - takes name of streamer, # of runs to get (default = 1) and returns the numeric id of that run, ex: 112309
// 2. getWorld - takes numeric run id and returns .json info about that run
// 3. getSplitMs - takes world json, milestone name (ex: nether), clock type (default = RTA) and returns the milestone's time in milliseconds. If
// missing it returns null.

const BASE = "https://paceman.gg/stats/api"; //a variable of the "base" of the API link needed for every call
const LIVE_RUNS_URL = "https://paceman.gg/api/ars/liveruns";
const LIVE_RUNS_TTL_MS = 2_000;
let liveRunsCache = { at: 0, data: [] };

async function getRecentRunId(name, limit = 1) {
  // takes name of streamer, # of runs to get (default = 1) and returns the numeric id of that run, ex: 112309
  // *remember async+await just pauses this function's execution while it waits for the data, letting rest of program continue. it immediately returns a Promise which is what it sounds like.
  const r = await fetch(
    `${BASE}/getRecentRuns?name=${encodeURIComponent(name)}&limit=${limit}`
  ); //encodeURIComponent makes characters not allowed in URLs ok

  if (!r.ok) {
    if (r.status === 404) return null; // “no runs / not found” → just return null
    throw new Error(`getRecentRuns ${r.status}`);
  }
  const arr = await r.json();
  return arr?.[0]?.id ?? null; // if arr + arr[0] within exists, return its id. if none (??) return null
}

async function getRecentRuns(name, limit = 5) {
  const r = await fetch(
    `${BASE}/getRecentRuns?name=${encodeURIComponent(name)}&limit=${limit}`
  );
  if (!r.ok) {
    if (r.status === 404) return [];
    throw new Error(`getRecentRuns ${r.status}`);
  }
  const arr = await r.json();
  return Array.isArray(arr) ? arr : [];
}

async function getWorld(runId) {
  const r = await fetch(
    `${BASE}/getWorld/?worldId=${encodeURIComponent(runId)}`
  );
  if (!r.ok) throw new Error(`getWorld ${r.status}`);
  return r.json(); // { data: {...}, isLive: bool, ... }
}

// Paceman API: get unix timestamps for splits in recent runs.
// Docs: https://paceman.gg/stats/api/ (getRecentTimestamps)
async function getRecentTimestamps(name, limit = 20, onlyFort = false) {
  const lim = Math.max(1, Math.min(50, Math.trunc(limit)));
  const r = await fetch(
    `${BASE}/getRecentTimestamps/?name=${encodeURIComponent(name)}&limit=${lim}&onlyFort=${onlyFort ? "true" : "false"}`
  );
  if (!r.ok) {
    if (r.status === 404) return [];
    throw new Error(`getRecentTimestamps ${r.status}`);
  }
  const arr = await r.json();
  return Array.isArray(arr) ? arr : [];
}

async function getLiveRuns() {
  if (typeof fetch !== "function") {
    throw new Error("getLiveRuns requires global fetch");
  }
  const now = Date.now();
  if (now - liveRunsCache.at < LIVE_RUNS_TTL_MS) {
    return liveRunsCache.data;
  }
  const r = await fetch(LIVE_RUNS_URL);
  if (!r.ok) throw new Error(`getLiveRuns ${r.status}`);
  const data = await r.json();
  liveRunsCache = {
    at: now,
    data: Array.isArray(data) ? data : [],
  };
  return liveRunsCache.data;
}

// takes world .json, milestone name (ex: nether), clock type (default = RTA) and returns the milestone's time in milliseconds.
// If missing it returns null.
function toCamelCase(s) {
  const raw = String(s || "");
  if (!raw.includes("_")) return raw;
  const [head, ...rest] = raw.split("_");
  return head + rest.map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}

function getSplitMs(world, base, clock = "RTA") {
  const c = String(clock).toUpperCase();
  const camelBase = toCamelCase(base);

  // Paceman getWorld payload stores:
  // - IGT: bare keys (e.g. "nether", "bastion", "first_portal")
  // - RTA: "Rta" suffix (e.g. "netherRta")
  // Ref: https://paceman.gg/stats/api/ (getWorld examples)
  const data = world?.data || {};

  if (c === "IGT") {
    const candidates = [
      data?.[base],
      data?.[`${base}Igt`],
      data?.[camelBase],
      data?.[`${camelBase}Igt`],
    ];
    for (const v of candidates) {
      if (Number.isFinite(v) && v >= 0) return v;
    }
    return null;
  }

  const candidates = [data?.[`${base}Rta`], data?.[`${camelBase}Rta`]];
  for (const v of candidates) {
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

module.exports = {
  getRecentRunId,
  getRecentRuns,
  getRecentTimestamps,
  getLiveRuns,
  getWorld,
  getSplitMs,
};
