/**
 * Watcher logic unit tests
 *
 * Why these exist:
 * - We hit a real bug where only `defaultMilestones` were evaluated, so profile-only milestones (like bastion) never notified.
 * - Quiet hours are easy to regress, especially for wrap-around ranges (e.g. 23:00-02:00).
 *
 * These tests run the watcher helpers as pure functions (no loops, no network).
 *
 * If this file fails:
 * - You may have broken config merging or quiet-hours logic.
 */

import { describe, it, expect } from "vitest";

import watcher from "../../src/watcher/run_watcher.js";

const { buildMilestones, inQuietHours, isTimeInQuietRange } = watcher;

function at(hhmm) {
  // Helper to create a Date whose local HH:MM matches hhmm (date component doesn't matter here).
  // Use a fixed date so tests are deterministic.
  return new Date(`2026-01-02T${hhmm}:00`);
}

describe("watcher helpers", () => {
  // Test: buildMilestones includes profile-only milestones (not just defaults)
  it("buildMilestones includes profile-only milestones (not just defaults)", () => {
    // Beginner summary: if a streamer profile contains milestones not in defaultMilestones,
    // the watcher still needs to evaluate them (or you'll miss alerts).
    const cfg = {
      streamers: ["xQcOW"],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {
        xQcOW: {
          bastion: { thresholdSec: 400, enabled: true },
        },
      },
    };

    const { STREAMER_MILESTONES } = buildMilestones(cfg);
    expect(Object.keys(STREAMER_MILESTONES.xQcOW)).toContain("nether");
    expect(Object.keys(STREAMER_MILESTONES.xQcOW)).toContain("bastion");
  });

  // Test: inQuietHours handles wrap-around ranges
  it("inQuietHours handles wrap-around ranges", () => {
    // Beginner summary: quiet hours like 23:00-02:00 should treat times after midnight as "quiet".
    const range = "23:00-02:00";

    expect(inQuietHours(range, new Date("2026-01-01T23:30:00"))).toBe(true);
    expect(inQuietHours(range, new Date("2026-01-02T01:30:00"))).toBe(true);
    expect(inQuietHours(range, new Date("2026-01-02T03:00:00"))).toBe(false);
  });

  // Test: isTimeInQuietRange uses start-inclusive / end-exclusive semantics
  it("isTimeInQuietRange uses start-inclusive / end-exclusive semantics", () => {
    // 12:00-14:00 means [12:00, 14:00)
    expect(isTimeInQuietRange("12:00-14:00", at("12:00"))).toBe(true);
    expect(isTimeInQuietRange("12:00-14:00", at("13:59"))).toBe(true);
    expect(isTimeInQuietRange("12:00-14:00", at("14:00"))).toBe(false);
    expect(isTimeInQuietRange("12:00-14:00", at("11:59"))).toBe(false);
  });

  // Test: inQuietHours supports multiple spans (array) and matches only inside them
  it("inQuietHours supports multiple spans (array) and matches only inside them", () => {
    const spans = ["21:00-09:00", "12:00-14:00"];

    // inside overnight span
    expect(inQuietHours(spans, at("21:00"))).toBe(true);
    expect(inQuietHours(spans, at("01:00"))).toBe(true);
    expect(inQuietHours(spans, at("08:59"))).toBe(true);
    expect(inQuietHours(spans, at("09:00"))).toBe(false);

    // inside midday span
    expect(inQuietHours(spans, at("12:00"))).toBe(true);
    expect(inQuietHours(spans, at("13:00"))).toBe(true);
    expect(inQuietHours(spans, at("14:00"))).toBe(false);

    // outside all spans
    expect(inQuietHours(spans, at("10:00"))).toBe(false);
    expect(inQuietHours(spans, at("15:00"))).toBe(false);
    expect(inQuietHours(spans, at("20:59"))).toBe(false);
  });

  // Test: inQuietHours is resilient to invalid entries in multi-span arrays
  it("inQuietHours is resilient to invalid entries in multi-span arrays", () => {
    const spans = ["nope", "12:00-14:00", "25:00-26:00"];
    expect(inQuietHours(spans, at("13:00"))).toBe(true);
    expect(inQuietHours(spans, at("15:00"))).toBe(false);
  });

  // Test: buildMilestones preserves enabled flag from defaults and profiles
  it("buildMilestones preserves enabled flag from defaults and profiles", () => {
    // Critical: The enabled flag must be preserved through config merging
    // so that disabled milestones in the UI actually suppress notifications.
    const cfg = {
      streamers: ["xQcOW"],
      defaultMilestones: {
        nether: { thresholdSec: 240, enabled: true },
        bastion: { thresholdSec: 600, enabled: false }, // disabled in defaults
      },
      profiles: {
        xQcOW: {
          nether: { enabled: false }, // disabled in profile (overrides default)
          fortress: { thresholdSec: 800, enabled: true }, // profile-only, enabled
        },
      },
    };

    const { STREAMER_MILESTONES } = buildMilestones(cfg);
    const xqcMilestones = STREAMER_MILESTONES.xQcOW;

    // nether: profile overrides default, should be disabled
    expect(xqcMilestones.nether.enabled).toBe(false);
    expect(xqcMilestones.nether.thresholdSec).toBe(240); // threshold from default

    // bastion: only in defaults, should be disabled
    expect(xqcMilestones.bastion.enabled).toBe(false);
    expect(xqcMilestones.bastion.thresholdSec).toBe(600);

    // fortress: profile-only, should be enabled
    expect(xqcMilestones.fortress.enabled).toBe(true);
    expect(xqcMilestones.fortress.thresholdSec).toBe(800);
  });
});
