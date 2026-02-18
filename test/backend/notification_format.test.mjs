/**
 * Notification formatting tests (cosmetic but user-facing)
 *
 * These lock in the exact banner style you requested:
 * "First Portal 🌀✨ — 3:12 (xQcOW)"
 */

import { describe, it, expect } from "vitest";

import fmt from "../../src/watcher/notification_format.js";

const { milestoneEmoji, milestonePrettyLabel, formatNotificationTitle } = fmt;

describe("notification title formatting", () => {
  // Test: maps milestone -> emoji exactly
  it("maps milestone -> emoji exactly", () => {
    // Beginner summary: each milestone gets a recognizable emoji set in the banner.
    expect(milestoneEmoji("nether")).toBe("🔥");
    expect(milestoneEmoji("bastion")).toBe("🟨🐷");
    expect(milestoneEmoji("fortress")).toBe("🏰🧱");
    expect(milestoneEmoji("first_portal")).toBe("🌀✨");
    expect(milestoneEmoji("stronghold")).toBe("👁️");
    expect(milestoneEmoji("end")).toBe("🐉");
    expect(milestoneEmoji("finish")).toBe("👑");
  });

  // Test: maps milestone -> friendly label exactly
  it("maps milestone -> friendly label exactly", () => {
    // Beginner summary: labels should be human-friendly (not raw config keys).
    expect(milestonePrettyLabel("nether")).toBe("Nether");
    expect(milestonePrettyLabel("bastion")).toBe("Bastion");
    expect(milestonePrettyLabel("fortress")).toBe("Fortress");
    expect(milestonePrettyLabel("first_portal")).toBe("First Portal");
    expect(milestonePrettyLabel("stronghold")).toBe("Stronghold");
    expect(milestonePrettyLabel("end")).toBe("End");
    expect(milestonePrettyLabel("finish")).toBe("Finish");
  });

  // Test: formats the title like: <Milestone> <emoji> — M:SS (<streamer>)
  it("formats the title like: <Milestone> <emoji> — M:SS (<streamer>)", () => {
    // Beginner summary: this is the exact banner style shown to users.
    const t1 = formatNotificationTitle({
      milestone: "bastion",
      splitMs: 4 * 60 * 1000 + 31 * 1000,
      streamer: "forsen",
    });
    expect(t1).toBe("Bastion 🟨🐷 — 4:31 (forsen)");

    const t2 = formatNotificationTitle({
      milestone: "first_portal",
      splitMs: 3 * 60 * 1000 + 12 * 1000,
      streamer: "xQcOW",
    });
    expect(t2).toBe("First Portal 🌀✨ — 3:12 (xQcOW)");
  });
});
