import "./App.css";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  API_BASE,
  getConfig,
  getProfiles,
  getStatuses,
  getToken,
  testNotify,
  putConfig,
} from "./api";
import { CANONICAL_MILESTONES, milestoneLabel } from "./config";

type MilestoneCfg = { thresholdSec?: number; enabled?: boolean };
type Config = {
  streamers: string[];
  clock: string;
  // Back-compat: string "HH:MM-HH:MM". New: string[] of such ranges (multi-span).
  quietHours?: string | string[];
  profiles?: Record<string, Record<string, MilestoneCfg>>;
  defaultMilestones?: Record<string, MilestoneCfg>;
  notifications?: {
    enabled?: boolean;
    sound?: boolean;
  };
  agent?: {
    autoUpdate?: boolean;
    forsenOcr?: boolean;
  };
};

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function splitMMSS(thresholdSec?: number): { mm: string; ss: string } {
  if (thresholdSec == null || !Number.isFinite(thresholdSec))
    return { mm: "", ss: "" };
  const total = Math.max(0, Math.trunc(thresholdSec));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return { mm: String(mm), ss: String(ss).padStart(2, "0") };
}

const APP_VERSION = "0.1";
const APP_CHANNEL = "Beta";
const MAX_STREAMERS = 15;
const MAX_QUIET_SPANS = 3;
const BROWSER_ALERTS_KEY = "runalert-browser-alerts";
const BROWSER_ALERTS_DEDUPE_KEY = "runalert-browser-alerts-dedupe";

type AmPm = "AM" | "PM";
type Time12 = { hh: string; mm: string; ampm: AmPm };
type QuietSpanDraft = { start: Time12; end: Time12 };

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function normalizeQuietHoursToArray(q: Config["quietHours"]): string[] {
  if (!q) return [];
  if (Array.isArray(q)) return q.filter((s) => typeof s === "string");
  if (typeof q === "string") return [q];
  return [];
}

function parseHHMM(s: string): { hh: number; mm: number } | null {
  const m = String(s || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function isTimeInQuietRange(range: string, date = new Date()): boolean {
  const parts = String(range || "").split("-");
  if (parts.length !== 2) return false;
  const start = parseHHMM(parts[0]);
  const end = parseHHMM(parts[1]);
  if (!start || !end) return false;

  const now = date.getHours() * 60 + date.getMinutes();
  const startMin = start.hh * 60 + start.mm;
  const endMin = end.hh * 60 + end.mm;

  if (startMin === endMin) return true;
  if (startMin < endMin) return now >= startMin && now < endMin;
  return now >= startMin || now < endMin;
}

function inQuietHours(q: Config["quietHours"], date = new Date()): boolean {
  const ranges = normalizeQuietHoursToArray(q);
  for (const r of ranges) {
    if (isTimeInQuietRange(r, date)) return true;
  }
  return false;
}

function to12({ hh, mm }: { hh: number; mm: number }): Time12 {
  const ampm: AmPm = hh >= 12 ? "PM" : "AM";
  const hh12 = hh % 12 === 0 ? 12 : hh % 12;
  return { hh: String(hh12), mm: pad2(mm), ampm };
}

function to24(t: Time12): { hh: number; mm: number } | null {
  const hhRaw = t.hh.trim();
  const mmRaw = t.mm.trim();
  if (!hhRaw || !mmRaw) return null;
  const hh12 = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh12) || !Number.isFinite(mm)) return null;
  if (hh12 < 1 || hh12 > 12) return null;
  if (mm < 0 || mm > 59) return null;
  const base = hh12 % 12; // 12 -> 0
  const hh = t.ampm === "PM" ? base + 12 : base;
  return { hh, mm };
}

function parseQuietRangeToDraft(range: string): QuietSpanDraft | null {
  const parts = String(range || "").split("-");
  if (parts.length !== 2) return null;
  const a = parseHHMM(parts[0]);
  const b = parseHHMM(parts[1]);
  if (!a || !b) return null;
  return { start: to12(a), end: to12(b) };
}

function formatTime12(t: Time12): string {
  const hh = t.hh.trim() || "—";
  const mm = t.mm.trim() || "—";
  return `${hh}:${mm} ${t.ampm}`;
}

function formatQuietHoursSummary(q: Config["quietHours"]): string {
  const ranges = normalizeQuietHoursToArray(q);
  const parts: string[] = [];
  for (const r of ranges) {
    const d = parseQuietRangeToDraft(r);
    if (!d) continue;
    parts.push(`${formatTime12(d.start)}–${formatTime12(d.end)}`);
  }
  if (!parts.length) return "Set quiet hours";
  return parts.join(", ");
}

function defaultQuietSpan(): QuietSpanDraft {
  // A reasonable starting point (common DND pattern).
  return {
    start: { hh: "9", mm: "00", ampm: "PM" },
    end: { hh: "9", mm: "00", ampm: "AM" },
  };
}

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showQuietHours, setShowQuietHours] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [showAddStreamer, setShowAddStreamer] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [installCopied, setInstallCopied] = useState(false);
  const [showInstallDetails, setShowInstallDetails] = useState(false);
  const [addStreamerName, setAddStreamerName] = useState("");
  const [addStreamerErr, setAddStreamerErr] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [showCopyFallback, setShowCopyFallback] = useState(false);

  const [draft, setDraft] = useState<Record<string, MilestoneCfg>>({});
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<
    "idle" | "sending" | "success" | "error"
  >("idle");
  const [browserAlertsEnabled, setBrowserAlertsEnabled] = useState(false);
  const [browserAlertsErr, setBrowserAlertsErr] = useState<string | null>(null);
  const [allToggleOn, setAllToggleOn] = useState(true);
  const [allToggleOwner, setAllToggleOwner] = useState<string | null>(null);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [quietDraft, setQuietDraft] = useState<QuietSpanDraft[]>([]);
  const [quietErr, setQuietErr] = useState<string | null>(null);
  const [quietSaving, setQuietSaving] = useState(false);
  const [statusByName, setStatusByName] = useState<
    Record<
      string,
      {
        runId: number | null;
        isLive: boolean;
        isActive?: boolean;
        runIsActive?: boolean;
        isTwitchLive?: boolean;
        twitch?: string | null;
        lastMilestone?: string | null;
        lastMilestoneMs?: number | null;
        lastUpdatedSec?: number | null;
        runStartSec?: number | null;
        recentFinishMs?: number | null;
        recentFinishUpdatedSec?: number | null;
      }
    >
  >({});
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [profileByName, setProfileByName] = useState<
    Record<string, { avatarUrl: string | null; twitch?: string | null }>
  >({});

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratingDraftRef = useRef(false);
  const queuedSaveRef = useRef(false);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const browserAlertDedupeRef = useRef<
    Record<string, { runId: number | null; milestones: Record<string, boolean> }>
  >({});

  const installToken = getToken();
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  const installBase = API_BASE || origin;
  const installUrl = `${installBase}/install/macos.command${
    installToken ? `?token=${encodeURIComponent(installToken)}` : ""
  }`;
  const viewInstallUrl = `${installUrl}${
    installUrl.includes("?") ? "&" : "?"
  }view=1`;
  const installCommand = `curl -fsSL "${viewInstallUrl}" | bash`;

  const milestoneEntries = Object.entries(draft);
  const anyMilestones = milestoneEntries.length > 0;
  const allEnabled =
    anyMilestones && milestoneEntries.every(([, cfg]) => cfg.enabled ?? true);
  const anyEnabled = milestoneEntries.some(([, cfg]) => cfg.enabled ?? true);
  const notificationsEnabled = cfg?.notifications?.enabled ?? true;
  const notificationSoundEnabled = cfg?.notifications?.sound ?? true;
  const agentAutoUpdateEnabled = cfg?.agent?.autoUpdate ?? false;
  const forsenOcrEnabled = cfg?.agent?.forsenOcr ?? false;

  function getTwitchUrl(name: string) {
    const raw =
      profileByName[name]?.twitch || statusByName?.[name]?.twitch || name;
    const handle = String(raw || "").trim();
    if (!handle) return null;
    return `https://twitch.tv/${encodeURIComponent(handle)}`;
  }

  function getPacemanStatsUrl(name: string) {
    const handle = String(name || "").trim();
    if (!handle) return null;
    return `https://paceman.gg/stats/player/${encodeURIComponent(handle)}/runs/`;
  }

  function isStreamerLive(name: string): boolean {
    const s = statusByName?.[name];
    return s?.isTwitchLive === true;
  }

  async function copyInstallCommand() {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(installCommand);
        setInstallCopied(true);
        setTimeout(() => setInstallCopied(false), 1800);
        return;
      }
    } catch {
      // fall through to manual prompt
    }
    setShowCopyFallback(true);
  }

  function persistBrowserAlerts(enabled: boolean) {
    setBrowserAlertsEnabled(enabled);
    try {
      window.localStorage.setItem(BROWSER_ALERTS_KEY, String(enabled));
    } catch {
      // ignore storage failures
    }
  }

  async function enableBrowserAlerts() {
    setBrowserAlertsErr(null);
    if (typeof Notification === "undefined") {
      setBrowserAlertsErr("Browser notifications are not supported here.");
      return;
    }
    if (Notification.permission === "granted") {
      persistBrowserAlerts(true);
      return;
    }
    if (Notification.permission === "denied") {
      setBrowserAlertsErr(
        "Notifications are blocked in this browser. Enable them in browser settings."
      );
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      persistBrowserAlerts(true);
    } else {
      setBrowserAlertsErr("Notification permission was denied.");
    }
  }

  function disableBrowserAlerts() {
    setBrowserAlertsErr(null);
    persistBrowserAlerts(false);
  }

  function loadBrowserAlertDedupe() {
    try {
      const raw = window.localStorage.getItem(BROWSER_ALERTS_DEDUPE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        browserAlertDedupeRef.current = parsed;
      }
    } catch {
      // ignore
    }
  }

  function saveBrowserAlertDedupe() {
    try {
      window.localStorage.setItem(
        BROWSER_ALERTS_DEDUPE_KEY,
        JSON.stringify(browserAlertDedupeRef.current)
      );
    } catch {
      // ignore
    }
  }

  function getDedupeEntry(name: string, runId: number) {
    const cur = browserAlertDedupeRef.current[name];
    if (!cur || cur.runId !== runId) {
      browserAlertDedupeRef.current[name] = {
        runId,
        milestones: {},
      };
    }
    return browserAlertDedupeRef.current[name];
  }

  function shouldNotifyBrowserAlert(
    name: string,
    milestone: string,
    ms: number | null | undefined
  ) {
    if (!cfg) return false;
    if (!Number.isFinite(ms) || (ms as number) < 0) return false;
    const merged = getMilestonesForStreamer(name)[milestone];
    if (!merged || !merged.enabled) return false;
    const thresholdSec = merged.thresholdSec;
    if (!Number.isFinite(thresholdSec) || (thresholdSec as number) <= 0)
      return false;
    return (ms as number) <= (thresholdSec as number) * 1000;
  }

  function maybeSendBrowserAlerts(statuses: Record<string, any>) {
    if (!cfg || !browserAlertsEnabled) return;
    if (!notificationsEnabled) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (inQuietHours(cfg.quietHours)) return;

    const clock = String(cfg.clock || "IGT").toUpperCase();
    const clockKey = clock === "RTA" ? "rta" : "igt";

    for (const name of cfg.streamers ?? []) {
      const status = statuses?.[name];
      if (!status?.runId || status?.runIsActive !== true) continue;
      const splits = status?.splits;
      if (!splits || typeof splits !== "object") continue;

      const entry = getDedupeEntry(name, status.runId);
      for (const milestone of CANONICAL_MILESTONES) {
        const ms = splits?.[milestone]?.[clockKey];
        if (!shouldNotifyBrowserAlert(name, milestone, ms)) continue;
        if (entry.milestones?.[milestone]) continue;

        const time = formatRunTime(ms) ?? "—";
        const label = milestoneBadgeText(milestone);
        const emoji = milestoneEmoji(milestone);
        const title = `${label}${emoji ? ` ${emoji}` : ""} — ${time} (${name})`;
        const streamUrl = getTwitchUrl(name);
        try {
          const notify = new Notification(title, {
            tag: `${name}-${milestone}-${status.runId}`,
            requireInteraction: true,
            silent: !notificationSoundEnabled,
          });
          if (streamUrl) {
            notify.onclick = () => {
              try {
                const tab = window.open(streamUrl, `runalert-stream-${name}`);
                tab?.focus?.();
              } catch {
                // ignore
              }
              try {
                notify.close();
              } catch {
                // ignore
              }
            };
          }
        } catch {
          // ignore
        }
        entry.milestones[milestone] = true;
        saveBrowserAlertDedupe();
      }
    }
  }

  async function sendTestNotification() {
    if (testStatus === "sending") return;
    setTestStatus("sending");
    try {
      await testNotify("runAlert test", "Agent is connected and ready.");
      setTestStatus("success");
      setTimeout(() => setTestStatus("idle"), 2500);
    } catch {
      setTestStatus("error");
      setTimeout(() => setTestStatus("idle"), 3500);
    }
  }

  function openQuietHoursEditor() {
    if (!cfg) {
      setErr("Config not loaded yet.");
      return;
    }
    const fromCfg = normalizeQuietHoursToArray(cfg.quietHours)
      .map(parseQuietRangeToDraft)
      .filter(Boolean) as QuietSpanDraft[];
    setQuietDraft(fromCfg.length ? fromCfg.slice(0, MAX_QUIET_SPANS) : []);
    setQuietErr(null);
    setShowQuietHours(true);
  }

  function validateQuietDraft(draft: QuietSpanDraft[]): {
    ok: boolean;
    ranges: string[];
    error?: string;
  } {
    const ranges: string[] = [];
    for (let i = 0; i < draft.length; i++) {
      const span = draft[i];
      const a = to24(span.start);
      const b = to24(span.end);
      if (!a || !b) {
        return {
          ok: false,
          ranges: [],
          error: `Quiet hours span ${i + 1} is incomplete or invalid.`,
        };
      }
      if (a.hh === b.hh && a.mm === b.mm) {
        return {
          ok: false,
          ranges: [],
          error: `Quiet hours span ${i + 1}: start and end cannot be the same.`,
        };
      }
      const start = `${pad2(a.hh)}:${pad2(a.mm)}`;
      const end = `${pad2(b.hh)}:${pad2(b.mm)}`;
      ranges.push(`${start}-${end}`);
    }
    return { ok: true, ranges };
  }

  // #region agent log
  // Header layout probe: capture bounding boxes so we can fix logo/title alignment with evidence.
  useLayoutEffect(() => {
    const runId = "pre-fix";

    function rect(el: Element | null) {
      if (!el) return null;
      const r = (el as HTMLElement).getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }

    function collect() {
      const frame = document.querySelector(".frame");
      const titleRow = document.querySelector(".titleRow");
      const brandRow = document.querySelector(".brandRow");
      const artSlot = document.querySelector(".brandArtSlot");
      const dragon = document.querySelector(".titleDragon");
      const title = document.querySelector(".appTitle");
      const meta = document.querySelector(".metaRow");

      const csDragon = dragon ? getComputedStyle(dragon as Element) : null;
      const payload = {
        vw: Math.round(window.innerWidth),
        vh: Math.round(window.innerHeight),
        dpr: window.devicePixelRatio,
        frame: rect(frame),
        titleRow: rect(titleRow),
        brandRow: rect(brandRow),
        artSlot: rect(artSlot),
        dragon: rect(dragon),
        title: rect(title),
        meta: rect(meta),
        dragonCss: csDragon
          ? {
              left: csDragon.left,
              top: csDragon.top,
              width: csDragon.width,
              height: csDragon.height,
              opacity: csDragon.opacity,
            }
          : null,
      };

      // Make the data accessible even if the ingest log file isn't readable.
      (window as any).__runAlertLayoutProbe = payload;
      // eslint-disable-next-line no-console
      console.log("[runAlert][layoutProbe] Header layout rects", payload);

      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/9552cddd-f9fe-446c-9ac5-0f4c76a346f5",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: "debug-session",
            runId,
            hypothesisId: "A",
            location: "dashboard/src/App.tsx:layoutProbe:collect",
            message: "Header layout rects",
            data: payload,
            timestamp: Date.now(),
          }),
        }
      ).catch(() => {});
      // #endregion agent log
    }

    let raf = 0;
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/9552cddd-f9fe-446c-9ac5-0f4c76a346f5",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "debug-session",
              runId,
              hypothesisId: "B",
              location: "dashboard/src/App.tsx:layoutProbe:onResize",
              message: "Header layout probe: resize",
              data: {
                vw: Math.round(window.innerWidth),
                vh: Math.round(window.innerHeight),
              },
              timestamp: Date.now(),
            }),
          }
        ).catch(() => {});
        // #endregion agent log
        collect();
      });
    };

    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/9552cddd-f9fe-446c-9ac5-0f4c76a346f5", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId,
        hypothesisId: "C",
        location: "dashboard/src/App.tsx:layoutProbe:mount",
        message: "Header layout probe mounted",
        data: { readyState: document.readyState },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion agent log

    // On-demand probe (DevTools):
    // `copy(JSON.stringify(window.__dumpRunAlertLayoutProbe(), null, 2))`
    (window as any).__dumpRunAlertLayoutProbe = () => {
      collect();
      return (window as any).__runAlertLayoutProbe;
    };

    collect();
    window.addEventListener("resize", onResize);

    return () => {
      delete (window as any).__dumpRunAlertLayoutProbe;
      delete (window as any).__runAlertLayoutProbe;
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  // #endregion agent log

  function openAddStreamerPrompt() {
    if (cfg && (cfg.streamers ?? []).length >= MAX_STREAMERS) {
      setErr(
        `Max streamers reached (${MAX_STREAMERS}). Remove one to add more.`
      );
      return;
    }
    setAddStreamerErr(null);
    setAddStreamerName("");
    setShowAddStreamer(true);
  }

  async function submitAddStreamer() {
    setAddStreamerErr(null);
    const name = addStreamerName.trim();
    if (!name) {
      setAddStreamerErr("Streamer name cannot be empty.");
      return;
    }
    if (!cfg) {
      setAddStreamerErr("Config not loaded yet.");
      return;
    }
    if ((cfg.streamers ?? []).length >= MAX_STREAMERS) {
      setAddStreamerErr(
        `Max streamers reached (${MAX_STREAMERS}). Remove one to add more.`
      );
      return;
    }

    const exists = (cfg.streamers ?? []).some(
      (s) => s.toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      setAddStreamerErr(`Streamer already exists: ${name}`);
      return;
    }

    // Optimistic UI update
    const optimistic: Config = structuredClone(cfg);
    optimistic.streamers = [...(optimistic.streamers ?? []), name];
    setCfg(optimistic);
    setErr(null);

    // Close modal immediately for a snappy feel
    setShowAddStreamer(false);

    try {
      const saved = await putConfig(optimistic);
      setCfg(saved);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      // Roll back to canonical config if save fails
      try {
        const latest = await getConfig();
        setCfg(latest);
      } catch {
        // keep existing error
      }
    }
  }

  async function removeStreamer(name: string) {
    if (!cfg) {
      setErr("Config not loaded yet.");
      return;
    }
    setPendingRemove(name);
    return;
  }

  async function confirmRemoveStreamer(name: string) {
    if (!cfg) {
      setErr("Config not loaded yet.");
      return;
    }

    // Optimistic UI update
    const optimistic: Config = structuredClone(cfg);
    optimistic.streamers = (optimistic.streamers ?? []).filter(
      (s) => s !== name
    );
    // Optionally delete the profile
    if (optimistic.profiles?.[name]) {
      delete optimistic.profiles[name];
    }
    setCfg(optimistic);
    setErr(null);

    // Close the panel if this streamer was selected
    if (selected === name) {
      setSelected(null);
    }

    try {
      const saved = await putConfig(optimistic);
      setCfg(saved);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      // Roll back to canonical config if save fails
      try {
        const latest = await getConfig();
        setCfg(latest);
      } catch {
        // keep existing error
      }
    }
  }

  useEffect(() => {
    getConfig()
      .then(setCfg)
      .catch((e) => setErr(e?.message ?? String(e)));
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BROWSER_ALERTS_KEY);
      if (raw === "true") {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          setBrowserAlertsEnabled(true);
        } else if (
          typeof Notification !== "undefined" &&
          Notification.permission === "denied"
        ) {
          setBrowserAlertsErr(
            "Notifications are blocked in this browser. Enable them in browser settings."
          );
        }
      }
    } catch {
      // ignore
    }
    loadBrowserAlertDedupe();
  }, []);

  useEffect(() => {
    if (!selected || !anyMilestones) return;
    if (selected !== allToggleOwner) {
      setAllToggleOwner(selected);
      setAllToggleOn(allEnabled);
    }
  }, [selected, allEnabled, anyMilestones, allToggleOwner]);

  // (no inline toast fallback)

  // Fetch streamer profile info (avatar URLs). Cached heavily server-side.
  useEffect(() => {
    if (!cfg) return;
    const names = cfg?.streamers ?? [];
    void getProfiles(names)
      .then((r) => setProfileByName(r.profiles ?? {}))
      .catch(() => {
        // Best-effort: avatars are cosmetic.
      });
  }, [cfg]);

  // Poll streamer statuses for the streamer tile indicator (badge).
  useEffect(() => {
    if (!cfg) return;

    async function pollOnce() {
      try {
        const names = cfg?.streamers ?? [];
        const r = await getStatuses(names);
        setStatusByName(r.statuses ?? {});
        maybeSendBrowserAlerts(r.statuses ?? {});
        setStatusErr(null);
      } catch {
        // Best-effort: don't spam errors for status polling.
        setStatusErr(
          "Live status unavailable (restart watcher to update API)."
        );
      }
    }

    void pollOnce();

    if (statusPollRef.current) clearInterval(statusPollRef.current);
    // Shorter interval so the badge updates without requiring manual reloads.
    statusPollRef.current = setInterval(pollOnce, 5_000);

    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    };
  }, [cfg]);

  async function persistDraft(reason: "manual" | "autosave") {
    if (!cfg || !selected) return;

    // If a save is already in-flight, queue one more attempt (Enter should "eventually" win).
    if (saving) {
      queuedSaveRef.current = true;
      return;
    }

    setSaving(true);
    setErr(null);
    try {
      const next = structuredClone(cfg);
      next.profiles = next.profiles || {};
      next.profiles[selected] = next.profiles[selected] || {};

      // Write milestone overrides into the profile
      for (const [milestone, mcfg] of Object.entries(draft)) {
        next.profiles[selected][milestone] = {
          ...next.profiles[selected][milestone],
          ...mcfg,
        };
      }

      const saved = await putConfig(next);
      setCfg(saved);
    } catch (e: any) {
      // If autosave fails, don't be noisy beyond showing the error; user can still hit Save.
      setErr(e?.message ?? String(e));
    } finally {
      setSaving(false);

      if (queuedSaveRef.current) {
        queuedSaveRef.current = false;
        // Fire-and-forget: run one more save with the latest draft.
        void persistDraft(reason);
      }
    }
  }

  useEffect(() => {
    if (!selected) return;
    hydratingDraftRef.current = true;
    setDraft(getMilestonesForStreamer(selected));
  }, [selected, cfg]);

  // Debounced autosave: whenever the user edits `draft`, persist after a short pause.
  useEffect(() => {
    if (!selected || !cfg) return;

    // Don't autosave when we are hydrating draft from config changes.
    if (hydratingDraftRef.current) {
      hydratingDraftRef.current = false;
      return;
    }

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void persistDraft("autosave");
    }, 700);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, selected]);

  const streamers: string[] = cfg?.streamers ?? [];
  const quietHoursSummary = formatQuietHoursSummary(cfg?.quietHours);

  function getNetherCutoffSec(name: string): number | null {
    if (!cfg) return null;

    const profile = cfg.profiles?.[name];
    const profileNether = profile?.nether?.thresholdSec;
    if (typeof profileNether === "number") return profileNether;

    const defaultNether = cfg.defaultMilestones?.nether?.thresholdSec;
    return typeof defaultNether === "number" ? defaultNether : null;
  }

  function getMilestonesForStreamer(
    name: string
  ): Record<string, MilestoneCfg> {
    if (!cfg) return {};

    const defaults = cfg.defaultMilestones ?? {};
    const profile = cfg.profiles?.[name] ?? {};

    const out: Record<string, MilestoneCfg> = {};

    // Canonical list first (so UI shows consistent milestones even if config is sparse)
    for (const milestone of CANONICAL_MILESTONES) {
      const base = defaults[milestone] ?? {};
      const override = profile[milestone] ?? {};
      const merged: MilestoneCfg = { ...base, ...override };

      // If nothing is configured anywhere, default to disabled for that milestone
      if (merged.enabled == null && merged.thresholdSec == null) {
        merged.enabled = false;
      }

      out[milestone] = merged;
    }

    // Include any profile-only milestones (future-proof)
    for (const [milestone, override] of Object.entries(profile)) {
      if (!out[milestone]) out[milestone] = { ...override };
    }

    return out;
  }

  function milestoneBadgeText(milestone: string): string {
    switch (milestone) {
      case "nether":
        return "Nether";
      case "bastion":
        return "Bastion";
      case "fortress":
        return "Fortress";
      case "first_portal":
        return "1st Portal";
      case "stronghold":
        return "Stronghold";
      case "end":
        return "End";
      case "finish":
        return "Finish";
      default:
        return String(milestone);
    }
  }

  function milestoneEmoji(milestone: string): string | null {
    switch (milestone) {
      case "nether":
        return "🔥";
      case "bastion":
        return "🟨🐷";
      case "fortress":
        return "🏰🧱";
      case "first_portal":
        return "🌀✨";
      case "stronghold":
        return "👁️";
      case "end":
        return "🐉";
      case "finish":
        return "👑";
      default:
        return null;
    }
  }

  function milestoneEnteredLabel(milestone: string): string {
    const label = milestoneBadgeText(milestone);
    if (milestone === "first_portal") return label;
    if (milestone === "finish") return label;
    return `Entered ${label}`;
  }

  function formatRunTime(ms?: number | null): string | null {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0)
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatAgo(sec?: number | null): string | null {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
    if (sec < 60) return `${Math.floor(sec)}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    const rem = min % 60;
    if (hr < 24) return `${hr}h ${rem}m ago`;
    const days = Math.floor(hr / 24);
    const remH = hr % 24;
    return remH > 0 ? `${days}d ${remH}h ago` : `${days}d ago`;
  }

  function getBadgeData(name: string): {
    milestone: string;
    ms?: number | null;
    updatedSec?: number | null;
    className: "final" | "live";
  } | null {
    const s = statusByName[name];
    if (!s) return null;

    // Finish grace: if previous run finished very recently but a new run started,
    // show a gold Finish badge for a short window.
    if (s.recentFinishMs != null) {
      return {
        milestone: "finish",
        ms: s.recentFinishMs,
        updatedSec: s.recentFinishUpdatedSec,
        className: "final",
      };
    }

    // Only show badges for runners that are "active on paceman" recently.
    if (s.isActive !== true) return null;

    if (!s.lastMilestone) return null;
    return {
      milestone: s.lastMilestone,
      ms: s.lastMilestoneMs,
      updatedSec: s.lastUpdatedSec,
      className: s.lastMilestone === "finish" ? "final" : "live",
    };
  }

  function badgeTitleFor(name: string): string {
    const s = statusByName[name];
    const badge = getBadgeData(name);
    if (!s || !badge) return "";

    const label = milestoneBadgeText(badge.milestone);
    const split = formatRunTime(badge.ms);

    // Primary "ago" signal: Paceman updateTime bumps when new split data is recorded.
    const nowSec = Math.floor(Date.now() / 1000);
    const agoFromUpdate =
      typeof badge.updatedSec === "number" && Number.isFinite(badge.updatedSec)
        ? formatAgo(Math.max(0, nowSec - badge.updatedSec))
        : null;

    // Fallback: approximate "when did this milestone happen" from insertTime + split.
    const milestoneAtSec =
      typeof s.runStartSec === "number" &&
      Number.isFinite(s.runStartSec) &&
      typeof badge.ms === "number" &&
      Number.isFinite(badge.ms)
        ? s.runStartSec + Math.floor(badge.ms / 1000)
        : null;
    const agoFromRunStart =
      typeof milestoneAtSec === "number"
        ? formatAgo(Math.max(0, nowSec - milestoneAtSec))
        : null;

    const ago = agoFromUpdate ?? agoFromRunStart;
    return [`${label}${split ? `: ${split}` : ""}`, ago]
      .filter(Boolean)
      .join(" • ");
  }

  function subtitleFor(name: string): string | null {
    const s = statusByName[name];
    const badge = getBadgeData(name);
    if (!s) return null;
    if (badge) return badgeTitleFor(name);

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof s.lastUpdatedSec === "number") {
      const ago = formatAgo(Math.max(0, nowSec - s.lastUpdatedSec));
      return ago ? `Last update • ${ago}` : null;
    }
    return null;
  }

  return (
    <div className="page">
      <div className="frame" data-testid="header-frame">
        <div className="titleRow" data-testid="header-titleRow">
          <div className="titleLeft">
            <div className="brandRow" data-testid="header-brandRow">
              <div
                className="brandArtSlot"
                data-testid="header-artSlot"
                aria-hidden="true"
              >
                <span className="titleDragon" data-testid="header-dragon" />
              </div>
              <div className="brandText">
                <div className="titleLine">
                  <h1 className="appTitle" data-testid="header-title">
                    Minecraft Speedrun Notifier
                  </h1>
                </div>
                <div className="metaRow" data-testid="header-meta">
                  <span className="tag">
                    {APP_CHANNEL} · v{APP_VERSION}
                  </span>
                  <button
                    type="button"
                    className="quietHoursPill"
                    onClick={openQuietHoursEditor}
                    aria-label="Edit quiet hours"
                    data-testid="header-quietHours"
                    title="During quiet hours, runAlert keeps monitoring but does not send notifications."
                  >
                    Quiet Hours: {quietHoursSummary}
                  </button>
                </div>
                <div className="betaDisclaimer">
                  Beta preview: possible bugs. Settings are saved per browser.
                </div>
              </div>
            </div>
            {statusErr ? (
              <div style={{ marginTop: 6, color: "#ffb86b", fontSize: 14 }}>
                {statusErr}
              </div>
            ) : null}
          </div>

          <button
            className="iconBtn"
            aria-label="Open settings"
            onClick={() => setShowSettings(true)}
          >
            <svg
              className="iconSvg gear"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.1 7.1 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.5a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.56ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"
              />
            </svg>
          </button>
        </div>

        {err ? (
          <div style={{ color: "#ff6b6b", marginTop: 12 }}>{err}</div>
        ) : null}
        {!cfg ? (
          <div style={{ marginTop: 12, color: "#999" }}>Loading config…</div>
        ) : null}

        {selected && cfg ? (
          <div
            style={{
              marginTop: 18,
              padding: 16,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <a
                className={`label labelLink labelRow panelName ${
                  isStreamerLive(selected) ? "labelLive" : ""
                }`}
                href={getTwitchUrl(selected) ?? undefined}
                target="_blank"
                rel="noreferrer"
                title="Open stream"
              >
                <span>{selected}</span>
                {isStreamerLive(selected) ? (
                  <span className="liveDot on" aria-hidden="true" />
                ) : null}
              </a>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() => removeStreamer(selected)}
                  style={{ height: 36, borderRadius: 10 }}
                >
                  Remove
                </button>
                <button
                  onClick={() => setSelected(null)}
                  style={{ height: 36, borderRadius: 10 }}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="driftNote">
              <a
                href="https://paceman.gg/"
                target="_blank"
                rel="noreferrer"
              >
                Paceman
              </a>{" "}
              split times can drift vs in-VOD IGT. Add a small buffer (about a
              minute) to your thresholds for safety.
            </div>

            <div className="milestoneAllRow">
              <div>All milestones</div>
              <label className="milestoneAllToggle">
                <input
                  type="checkbox"
                  checked={allToggleOn}
                  disabled={!anyMilestones}
                  onChange={(e) => {
                    if (!anyMilestones) return;
                    const nextEnabled = e.target.checked;
                    setAllToggleOn(nextEnabled);
                    setDraft((d) => {
                      const next = { ...d };
                      for (const key of Object.keys(next)) {
                        next[key] = { ...next[key], enabled: nextEnabled };
                      }
                      return next;
                    });
                  }}
                />
                {allToggleOn ? "all on" : "all off"}
              </label>
            </div>

            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {Object.entries(draft).map(([milestone, mcfg]) => {
                const enabled = mcfg.enabled ?? true;
                const value = mcfg.thresholdSec;
                const { mm, ss } = splitMMSS(
                  typeof value === "number" ? value : undefined
                );

                return (
                  <div
                    key={milestone}
                    className="milestoneRow"
                    style={{ opacity: enabled ? 1 : 0.55 }}
                  >
                    <div style={{ fontSize: 18 }}>
                      {milestoneLabel(milestone)}
                    </div>

                    <div className="milestoneControls">
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          color: "#bdbdbd",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => {
                            const on = e.target.checked;
                            setDraft((d) => ({
                              ...d,
                              [milestone]: { ...d[milestone], enabled: on },
                            }));
                          }}
                        />
                        on
                      </label>

                      <div className="timeGroup">
                        <div className="timeLabels">
                          <div>min</div>
                          <div />
                          <div>sec</div>
                        </div>

                        <div className="timeInputs">
                          <div className="timePrefix">&lt;</div>

                          <input
                            type="number"
                            aria-label={`${milestone}-minutes`}
                            value={mm}
                            placeholder="0"
                            min={0}
                            step={1}
                            onChange={(e) => {
                              const raw = e.target.value;
                              // Minutes: allow blank; clamp to >= 0. (No hard max.)
                              const cur = draft[milestone]?.thresholdSec;
                              const curMm =
                                typeof cur === "number"
                                  ? Math.floor(cur / 60)
                                  : 0;
                              const curSs =
                                typeof cur === "number" ? cur % 60 : 0;

                              const nextMm =
                                raw === ""
                                  ? undefined
                                  : clampInt(Number(raw), 0, 9999);
                              const nextSec =
                                nextMm == null && raw === "" && ss === ""
                                  ? undefined
                                  : (nextMm ?? curMm) * 60 + curSs;

                              setDraft((d) => ({
                                ...d,
                                [milestone]: {
                                  ...d[milestone],
                                  thresholdSec: nextSec,
                                },
                              }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              if (autosaveTimerRef.current)
                                clearTimeout(autosaveTimerRef.current);
                              autosaveTimerRef.current = null;
                              void persistDraft("manual");
                            }}
                            className="timeField"
                          />

                          <div className="timeColon">:</div>

                          <input
                            type="number"
                            aria-label={`${milestone}-seconds`}
                            value={ss}
                            placeholder="00"
                            min={0}
                            max={59}
                            step={1}
                            onChange={(e) => {
                              const raw = e.target.value;
                              const cur = draft[milestone]?.thresholdSec;
                              const curMm =
                                typeof cur === "number"
                                  ? Math.floor(cur / 60)
                                  : 0;

                              const nextSs =
                                raw === ""
                                  ? undefined
                                  : clampInt(Number(raw), 0, 59);
                              const nextSec =
                                nextSs == null && raw === "" && mm === ""
                                  ? undefined
                                  : curMm * 60 + (nextSs ?? 0);

                              setDraft((d) => ({
                                ...d,
                                [milestone]: {
                                  ...d[milestone],
                                  thresholdSec: nextSec,
                                },
                              }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              if (autosaveTimerRef.current)
                                clearTimeout(autosaveTimerRef.current);
                              autosaveTimerRef.current = null;
                              void persistDraft("manual");
                            }}
                            className="timeField"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div
              style={{
                marginTop: 12,
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
              }}
            >
              <button
                onClick={() => {
                  if (!selected) return;
                  setDraft(getMilestonesForStreamer(selected)); // revert
                }}
                style={smallBtn}
              >
                Cancel
              </button>

              <button
                disabled={!cfg || !selected || saving}
                onClick={async () => {
                  if (autosaveTimerRef.current)
                    clearTimeout(autosaveTimerRef.current);
                  autosaveTimerRef.current = null;
                  await persistDraft("manual");
                }}
                style={{
                  ...smallBtn,
                  background: saving
                    ? "rgba(255,255,255,0.06)"
                    : "rgba(120,255,120,0.12)",
                  border: "1px solid rgba(120,255,120,0.25)",
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="grid">
          {streamers.map((name) => (
            <div className="avatarTile" key={name}>
              <button className="avatarBtn" onClick={() => setSelected(name)}>
                {profileByName[name]?.avatarUrl ? (
                  <img
                    className="avatarImg"
                    alt={`${name} avatar`}
                    src={profileByName[name].avatarUrl!}
                    loading="lazy"
                  />
                ) : null}
                {getBadgeData(name) ? (
                  <span
                    className={`milestoneBadge ${getBadgeData(name)!.className}`}
                    aria-label={`${name}-milestone`}
                    title={badgeTitleFor(name)}
                  >
                    {milestoneBadgeText(getBadgeData(name)!.milestone)}
                  </span>
                ) : null}
              </button>
              <a
                className={`label labelLink labelRow ${
                  isStreamerLive(name) ? "labelLive" : ""
                }`}
                href={getTwitchUrl(name) ?? undefined}
                target="_blank"
                rel="noreferrer"
                title="Open stream"
              >
                <span>{name}</span>
                {isStreamerLive(name) ? (
                  <span className="liveDot on" aria-hidden="true" />
                ) : null}
              </a>
              <a
                className="milestoneSubtitle milestoneLink"
                href={getPacemanStatsUrl(name) ?? undefined}
                target="_blank"
                rel="noreferrer"
                title="Open stats"
              >
                {subtitleFor(name) ?? "Last update • —"}
              </a>
            </div>
          ))}

          <div className="avatarTile addTile">
            <button className="avatarBtn add" onClick={openAddStreamerPrompt}>
              <svg className="addPlus" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M11 5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5Z"
                />
              </svg>
            </button>
            <div className="label">Add Streamer</div>
          </div>
        </div>

        <div className="alertsStrip alertsBottom">
          <div className="alertsBanner">
            <span
              className={`alertsDot ${browserAlertsEnabled ? "on" : "off"}`}
              aria-hidden="true"
            />
            <span className="alertsBannerText">
              Browser alerts only work while this tab is open. Install the Mac
              agent for background alerts.
            </span>
          </div>
          <div className="alertsRow">
            <button
              className="alertsToggleBtn"
              type="button"
              onClick={() =>
                browserAlertsEnabled
                  ? disableBrowserAlerts()
                  : enableBrowserAlerts()
              }
            >
              {browserAlertsEnabled
                ? "Browser alerts enabled"
                : "Enable browser alerts"}
            </button>
          </div>
          {browserAlertsErr ? (
            <div className="alertsError">{browserAlertsErr}</div>
          ) : null}
        </div>

        <div className="installCard">
          <div>
            <div className="installTitle">Install Mac Agent</div>
            <div className="installBody">
              Keep alerts running in the background even after you close this
              tab.
            </div>
            <div className="installMeta">
              <a
                className="installLink"
                href={viewInstallUrl}
                target="_blank"
                rel="noreferrer"
              >
                View what you're installing
              </a>{" "}
              — plain Bash script that clones the public{" "}
              <a
                className="installLink"
                href="https://github.com/jz-42/Minecraft-Speedrun-Notifier-BETA"
                target="_blank"
                rel="noreferrer"
              >
                git repo
              </a>{" "}
              and runs the watcher (no bitcoin miner).
            </div>
            <button
              className="installDetailsToggle"
              type="button"
              onClick={() => setShowInstallDetails((prev) => !prev)}
            >
              {showInstallDetails ? "Hide instructions" : "Instructions"}
            </button>
            {showInstallDetails ? (
              <div className="installDetails">
                <div className="installSteps">
                  <span className="installStepTitle">Option A (Finder)</span>
                  <br />
                  1. Download the installer
                  <br />
                  2. Right-click it → Open
                  <br />
                  3. If blocked: System Settings → Privacy &amp; Security → Open
                  Anyway
                </div>
                <div className="installSteps">
                  <span className="installStepTitle">Option B (Terminal)</span>
                  <br />
                  Copy/paste this to bypass Finder prompts:
                </div>
                <div className="installCommandRow">
                  <button
                    className="installCopy"
                    type="button"
                    onClick={copyInstallCommand}
                  >
                    {installCopied ? "Copied" : "Copy terminal command"}
                  </button>
                  <span className="installCommandHint">
                    Same installer, fewer prompts
                  </span>
                </div>
                <div className="installCommand">{installCommand}</div>
                <div className="installTestRow">
                  <button
                    className="installTest"
                    type="button"
                    onClick={sendTestNotification}
                    disabled={testStatus === "sending"}
                  >
                    {testStatus === "sending"
                      ? "Sending…"
                      : "Send test notification"}
                  </button>
                  <span className="installTestHint">
                    {testStatus === "success"
                      ? "Sent! Check your desktop notifications."
                      : testStatus === "error"
                        ? "No agent detected yet."
                        : "Use this after install to verify it works."}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
          <div className="installActions">
            <a
              className="installButton"
              href={installUrl}
              download
            >
              Download Mac Installer
            </a>
            <div className="installHint">macOS • Beta</div>
          </div>
        </div>

        <div className="creditRow">
          <span className="creditText">Powered by</span>{" "}
          <a
            className="creditLink"
            href="https://paceman.gg"
            target="_blank"
            rel="noreferrer"
          >
            paceman.gg
          </a>
        </div>

        {showSettings ? (
          <div
            onClick={() => setShowSettings(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(6px)",
              zIndex: 80,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "fixed",
                right: 80,
                top: 140,
                width: 420,
                padding: 26,
                borderRadius: 18,
                background: "var(--surfaceSolid)",
                boxShadow: "0 16px 60px rgba(0,0,0,0.55)",
                border: "1px solid var(--border)",
                zIndex: 81,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ fontSize: 44, fontWeight: 700 }}>Settings</div>
                <button
                  onClick={() => setShowSettings(false)}
                  className="iconBtn"
                  aria-label="Close settings"
                  style={{ width: 46, height: 46 }}
                >
                  <svg
                    className="iconSvg close"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 1 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"
                    />
                  </svg>
                </button>
              </div>

              <div style={{ marginTop: 18, display: "grid", gap: 14 }}>
                <button
                  style={settingsRowStyle}
                  onClick={() => {
                    setShowSettings(false);
                    openQuietHoursEditor();
                  }}
                >
                  Quiet Hours
                </button>
                <button
                  style={settingsRowStyle}
                  onClick={() => {
                    setShowSettings(false);
                    setShowNotifications(true);
                  }}
                >
                  Notifications
                </button>
                <button
                  style={settingsRowStyle}
                  onClick={() => {
                    setShowSettings(false);
                    setShowAgentSettings(true);
                  }}
                >
                  Agent (Mac)
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showNotifications ? (
          <div
            className="qhOverlay"
            onClick={() => setShowNotifications(false)}
          >
            <div
              className="qhModal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Notifications"
            >
              <div className="qhHeader">
                <div>
                  <div className="qhTitle">Notifications</div>
                  <div className="qhHelp">
                    Control whether runAlert shows browser notifications and
                    plays the alert sound.
                  </div>
                </div>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label="Close notifications"
                  style={{ width: 46, height: 46 }}
                  onClick={() => setShowNotifications(false)}
                >
                  <svg
                    className="iconSvg close"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 1 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"
                    />
                  </svg>
                </button>
              </div>

              <div className="notifBody">
                <label className="notifRow">
                  <span>Enable notifications</span>
                  <input
                    type="checkbox"
                    checked={notificationsEnabled}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!cfg) return;
                      const updated = structuredClone(cfg);
                      updated.notifications = {
                        ...(updated.notifications || {}),
                        enabled: next,
                        sound:
                          updated.notifications?.sound ??
                          notificationSoundEnabled,
                      };
                      setCfg(updated);
                      setErr(null);
                      void putConfig(updated).catch((e) =>
                        setErr(e?.message ?? String(e))
                      );
                    }}
                  />
                </label>
                <label className="notifRow">
                  <span>Notification sound</span>
                  <input
                    type="checkbox"
                    checked={notificationSoundEnabled}
                    disabled={!notificationsEnabled}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!cfg) return;
                      const updated = structuredClone(cfg);
                      updated.notifications = {
                        ...(updated.notifications || {}),
                        enabled:
                          updated.notifications?.enabled ??
                          notificationsEnabled,
                        sound: next,
                      };
                      setCfg(updated);
                      setErr(null);
                      void putConfig(updated).catch((e) =>
                        setErr(e?.message ?? String(e))
                      );
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        ) : null}

        {showAgentSettings ? (
          <div className="qhOverlay" onClick={() => setShowAgentSettings(false)}>
            <div
              className="qhModal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Agent"
            >
              <div className="qhHeader">
                <div>
                  <div className="qhTitle">Agent (Mac)</div>
                  <div className="qhHelp">
                    Control background alerts and experimental features for the
                    local agent.
                  </div>
                </div>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label="Close agent settings"
                  style={{ width: 46, height: 46 }}
                  onClick={() => setShowAgentSettings(false)}
                >
                  <svg
                    className="iconSvg close"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 1 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"
                    />
                  </svg>
                </button>
              </div>

              <div className="notifBody">
                <label className="notifRow">
                  <span>Auto‑update agent on launch</span>
                  <input
                    type="checkbox"
                    checked={agentAutoUpdateEnabled}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!cfg) return;
                      const updated = structuredClone(cfg);
                      updated.agent = {
                        ...(updated.agent || {}),
                        autoUpdate: next,
                        forsenOcr:
                          updated.agent?.forsenOcr ?? forsenOcrEnabled,
                      };
                      setCfg(updated);
                      setErr(null);
                      void putConfig(updated).catch((e) =>
                        setErr(e?.message ?? String(e))
                      );
                    }}
                  />
                </label>
                <label className="notifRow">
                  <span>Forsen OCR (experimental)</span>
                  <input
                    type="checkbox"
                    checked={forsenOcrEnabled}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!cfg) return;
                      const updated = structuredClone(cfg);
                      updated.agent = {
                        ...(updated.agent || {}),
                        autoUpdate:
                          updated.agent?.autoUpdate ?? agentAutoUpdateEnabled,
                        forsenOcr: next,
                      };
                      setCfg(updated);
                      setErr(null);
                      void putConfig(updated).catch((e) =>
                        setErr(e?.message ?? String(e))
                      );
                    }}
                  />
                </label>
                <div className="notifNote">
                  Forsen OCR requires the Mac agent and is opt‑in. It may use
                  extra CPU/bandwidth.
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {showQuietHours && cfg ? (
          <div
            className="qhOverlay"
            onClick={() => {
              if (quietSaving) return;
              setShowQuietHours(false);
              setQuietErr(null);
            }}
          >
            <div
              className="qhModal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Quiet hours"
            >
              <div className="qhHeader">
                <div>
                  <div className="qhTitle">Quiet Hours</div>
                  <div className="qhHelp">
                    During quiet hours, runAlert will keep monitoring runs, but
                    it will not send notifications.
                  </div>
                </div>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label="Close quiet hours"
                  style={{ width: 46, height: 46 }}
                  onClick={() => {
                    if (quietSaving) return;
                    setShowQuietHours(false);
                    setQuietErr(null);
                  }}
                >
                  <svg
                    className="iconSvg close"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 1 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"
                    />
                  </svg>
                </button>
              </div>

              {quietErr ? <div className="qhError">{quietErr}</div> : null}

              <div className="qhBody">
                {quietDraft.length ? (
                  <div className="qhList">
                    {quietDraft.map((span, idx) => {
                      const canRemove = !quietSaving;
                      return (
                        <div className="qhRow" key={idx}>
                          <div className="qhRowLabel">Span {idx + 1}</div>

                          <div className="qhTimes">
                            <div className="qhTimeBlock">
                              <div className="qhTimeCaption">Start</div>
                              <div className="qhTimeInputs">
                                <input
                                  className="qhTimeField"
                                  type="number"
                                  min={1}
                                  max={12}
                                  placeholder="9"
                                  value={span.start.hh}
                                  aria-label={`quiet-${idx}-start-hour`}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setQuietDraft((d) => {
                                      const next = d.slice();
                                      next[idx] = {
                                        ...next[idx],
                                        start: { ...next[idx].start, hh: v },
                                      };
                                      return next;
                                    });
                                  }}
                                />
                                <div className="qhColon">:</div>
                                <input
                                  className="qhTimeField"
                                  type="number"
                                  min={0}
                                  max={59}
                                  placeholder="00"
                                  value={span.start.mm}
                                  aria-label={`quiet-${idx}-start-minute`}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setQuietDraft((d) => {
                                      const next = d.slice();
                                      next[idx] = {
                                        ...next[idx],
                                        start: { ...next[idx].start, mm: v },
                                      };
                                      return next;
                                    });
                                  }}
                                />
                                <select
                                  className="qhAmPm"
                                  value={span.start.ampm}
                                  aria-label={`quiet-${idx}-start-ampm`}
                                  onChange={(e) => {
                                    const v = e.target.value as AmPm;
                                    setQuietDraft((d) => {
                                      const next = d.slice();
                                      next[idx] = {
                                        ...next[idx],
                                        start: { ...next[idx].start, ampm: v },
                                      };
                                      return next;
                                    });
                                  }}
                                >
                                  <option value="AM">AM</option>
                                  <option value="PM">PM</option>
                                </select>
                              </div>
                            </div>

                            <div className="qhTimeBlock">
                              <div className="qhTimeCaption">End</div>
                              <div className="qhTimeInputs">
                                <input
                                  className="qhTimeField"
                                  type="number"
                                  min={1}
                                  max={12}
                                  placeholder="9"
                                  value={span.end.hh}
                                  aria-label={`quiet-${idx}-end-hour`}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setQuietDraft((d) => {
                                      const next = d.slice();
                                      next[idx] = {
                                        ...next[idx],
                                        end: { ...next[idx].end, hh: v },
                                      };
                                      return next;
                                    });
                                  }}
                                />
                                <div className="qhColon">:</div>
                                <input
                                  className="qhTimeField"
                                  type="number"
                                  min={0}
                                  max={59}
                                  placeholder="00"
                                  value={span.end.mm}
                                  aria-label={`quiet-${idx}-end-minute`}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setQuietDraft((d) => {
                                      const next = d.slice();
                                      next[idx] = {
                                        ...next[idx],
                                        end: { ...next[idx].end, mm: v },
                                      };
                                      return next;
                                    });
                                  }}
                                />
                                <select
                                  className="qhAmPm"
                                  value={span.end.ampm}
                                  aria-label={`quiet-${idx}-end-ampm`}
                                  onChange={(e) => {
                                    const v = e.target.value as AmPm;
                                    setQuietDraft((d) => {
                                      const next = d.slice();
                                      next[idx] = {
                                        ...next[idx],
                                        end: { ...next[idx].end, ampm: v },
                                      };
                                      return next;
                                    });
                                  }}
                                >
                                  <option value="AM">AM</option>
                                  <option value="PM">PM</option>
                                </select>
                              </div>
                            </div>
                          </div>

                          <div className="qhRowActions">
                            <button
                              type="button"
                              className="qhRemove"
                              disabled={!canRemove}
                              onClick={() => {
                                setQuietDraft((d) =>
                                  d.filter((_, i) => i !== idx)
                                );
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="qhEmpty">
                    No quiet hours set. Add a span to mute notifications during
                    specific times.
                  </div>
                )}

                <div className="qhFooter">
                  <button
                    type="button"
                    className="qhAdd"
                    disabled={
                      quietSaving || quietDraft.length >= MAX_QUIET_SPANS
                    }
                    onClick={() => {
                      if (quietDraft.length >= MAX_QUIET_SPANS) return;
                      setQuietDraft((d) => [...d, defaultQuietSpan()]);
                    }}
                  >
                    Add span ({quietDraft.length}/{MAX_QUIET_SPANS})
                  </button>

                  <div className="qhFooterRight">
                    <button
                      type="button"
                      style={smallBtn}
                      disabled={quietSaving}
                      onClick={() => {
                        if (quietSaving) return;
                        setShowQuietHours(false);
                        setQuietErr(null);
                      }}
                    >
                      Cancel
                    </button>

                    <button
                      type="button"
                      disabled={quietSaving}
                      className="qhSave"
                      onClick={async () => {
                        if (!cfg) return;
                        const v = validateQuietDraft(quietDraft);
                        if (!v.ok) {
                          setQuietErr(v.error || "Invalid quiet hours.");
                          return;
                        }
                        setQuietSaving(true);
                        setQuietErr(null);
                        try {
                          const next = structuredClone(cfg);
                          next.quietHours = v.ranges;
                          const saved = await putConfig(next);
                          setCfg(saved);
                          setShowQuietHours(false);
                        } catch (e: any) {
                          setQuietErr(e?.message ?? String(e));
                        } finally {
                          setQuietSaving(false);
                        }
                      }}
                    >
                      {quietSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {showAddStreamer ? (
          <div
            className="qhOverlay"
            onClick={() => {
              setShowAddStreamer(false);
              setAddStreamerErr(null);
            }}
          >
            <div
              className="qhModal qhModal--xs"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Add streamer"
            >
              <div className="qhHeader">
                <div>
                  <div className="qhTitle">Add Streamer</div>
                  <div className="qhHelp">
                    Enter a Paceman player name (usually their Twitch handle).
                  </div>
                </div>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label="Close add streamer"
                  style={{ width: 46, height: 46 }}
                  onClick={() => {
                    setShowAddStreamer(false);
                    setAddStreamerErr(null);
                  }}
                >
                  <svg
                    className="iconSvg close"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 1 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"
                    />
                  </svg>
                </button>
              </div>

              {addStreamerErr ? (
                <div className="qhError">{addStreamerErr}</div>
              ) : null}

              <div className="promptBody">
                <div className="promptLabel">Streamer name</div>
                <input
                  className="promptInput"
                  value={addStreamerName}
                  onChange={(e) => setAddStreamerName(e.target.value)}
                  placeholder="e.g. xQcOW"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    void submitAddStreamer();
                  }}
                />
              </div>

              <div className="promptActions">
                <button
                  type="button"
                  style={smallBtn}
                  onClick={() => {
                    setShowAddStreamer(false);
                    setAddStreamerErr(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="qhSave"
                  onClick={() => void submitAddStreamer()}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {pendingRemove ? (
          <div
            className="qhOverlay"
            onClick={() => setPendingRemove(null)}
          >
            <div
              className="qhModal qhModal--sm"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Remove streamer"
            >
              <div className="qhHeader">
                <div>
                  <div className="qhTitle">Remove streamer?</div>
                  <div className="qhHelp">
                    This will remove <strong>{pendingRemove}</strong> from your
                    dashboard (and delete their saved thresholds on this browser).
                  </div>
                </div>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label="Close remove streamer"
                  style={{ width: 46, height: 46 }}
                  onClick={() => setPendingRemove(null)}
                >
                  <svg
                    className="iconSvg close"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 1 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"
                    />
                  </svg>
                </button>
              </div>

              <div className="promptActions">
                <button
                  type="button"
                  style={smallBtn}
                  onClick={() => setPendingRemove(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="qhSave"
                  onClick={() => {
                    const name = pendingRemove;
                    setPendingRemove(null);
                    if (name) void confirmRemoveStreamer(name);
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showCopyFallback ? (
          <div className="qhOverlay" onClick={() => setShowCopyFallback(false)}>
            <div
              className="qhModal qhModal--sm"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="Copy install command"
            >
              <div className="qhHeader">
                <div>
                  <div className="qhTitle">Copy install command</div>
                  <div className="qhHelp">
                    Your browser blocked clipboard access. Copy the command below.
                  </div>
                </div>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label="Close copy command"
                  style={{ width: 46, height: 46 }}
                  onClick={() => setShowCopyFallback(false)}
                >
                  <svg
                    className="iconSvg close"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 1 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"
                    />
                  </svg>
                </button>
              </div>

              <div className="installCommand" style={{ marginTop: 12 }}>
                {installCommand}
              </div>

              <div className="promptActions">
                <button
                  type="button"
                  style={smallBtn}
                  onClick={() => setShowCopyFallback(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const settingsRowStyle: CSSProperties = {
  height: 62,
  borderRadius: 12,
  border: "1px solid var(--borderStrong)",
  background: "rgba(20, 18, 32, 0.52)",
  color: "#ddd",
  fontSize: 24,
  textAlign: "left",
  padding: "0 18px",
  cursor: "pointer",
};

const smallBtn: CSSProperties = {
  height: 40,
  padding: "0 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "rgba(20, 18, 32, 0.48)",
  color: "#eaeaea",
  cursor: "pointer",
};

export default App;
