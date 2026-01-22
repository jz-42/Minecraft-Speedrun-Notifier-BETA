import "./App.css";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getConfig, getProfiles, getStatuses, putConfig } from "./api";
import { CANONICAL_MILESTONES, milestoneLabel } from "./config";

type MilestoneCfg = { thresholdSec?: number; enabled?: boolean };
type Config = {
  streamers: string[];
  clock: string;
  // Back-compat: string "HH:MM-HH:MM". New: string[] of such ranges (multi-span).
  quietHours?: string | string[];
  profiles?: Record<string, Record<string, MilestoneCfg>>;
  defaultMilestones?: Record<string, MilestoneCfg>;
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

const APP_VERSION = "0.9.0";
const APP_CHANNEL = "Beta";
const MAX_STREAMERS = 15;
const MAX_QUIET_SPANS = 3;

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
  const [selected, setSelected] = useState<string | null>(null);

  const [draft, setDraft] = useState<Record<string, MilestoneCfg>>({});
  const [saving, setSaving] = useState(false);

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
    Record<string, { avatarUrl: string | null }>
  >({});

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratingDraftRef = useRef(false);
  const queuedSaveRef = useRef(false);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  async function addStreamer() {
    if (cfg && (cfg.streamers ?? []).length >= MAX_STREAMERS) {
      setErr(
        `Max streamers reached (${MAX_STREAMERS}). Remove one to add more.`
      );
      return;
    }
    const raw = window.prompt("Streamer name (e.g. xQcOW):");
    if (raw == null) return; // cancelled

    const name = raw.trim();
    if (!name) {
      setErr("Streamer name cannot be empty.");
      return;
    }
    if (!cfg) {
      setErr("Config not loaded yet.");
      return;
    }

    const exists = (cfg.streamers ?? []).some(
      (s) => s.toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      setErr(`Streamer already exists: ${name}`);
      return;
    }

    // Optimistic UI update
    const optimistic: Config = structuredClone(cfg);
    optimistic.streamers = [...(optimistic.streamers ?? []), name];
    setCfg(optimistic);
    setErr(null);

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
      case "second_portal":
        return "2nd Portal";
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
    return `${hr}h ${rem}m ago`;
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
              <div style={{ fontSize: 26, fontWeight: 700 }}>{selected}</div>
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
              <div className="label">{name}</div>
              {getBadgeData(name) ? (
                <div className="milestoneSubtitle">{badgeTitleFor(name)}</div>
              ) : null}
            </div>
          ))}

          <div className="avatarTile addTile">
            <button className="avatarBtn add" onClick={addStreamer}>
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

        <div className="installCard">
          <div>
            <div className="installTitle">Install Mac Agent</div>
            <div className="installBody">
              Keep alerts running in the background even after you close this
              tab.
            </div>
            <div className="installSteps">
              1. Download the installer
              <br />
              2. Double-click it in Finder
              <br />
              3. Follow the prompts
            </div>
          </div>
          <div className="installActions">
            <a
              className="installButton"
              href="/install/macos.command"
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
                background: "#3a3b42",
                boxShadow: "0 16px 60px rgba(0,0,0,0.55)",
                border: "1px solid rgba(255,255,255,0.08)",
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
                <button style={settingsRowStyle}>Notification Type</button>
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
      </div>
    </div>
  );
}

const settingsRowStyle: CSSProperties = {
  height: 62,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.06)",
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
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.06)",
  color: "#eaeaea",
  cursor: "pointer",
};

export default App;
