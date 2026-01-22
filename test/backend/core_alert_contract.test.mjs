/**
 * Core alert contract tests (the “point of the project”)
 *
 * These tests lock in the invariant you described:
 * - For every milestone we track, if the split exists and is under the cutoff (and enabled),
 *   we should notify.
 *
 * This prevents future “UX fixes” (like mid-run suppression) from accidentally breaking alerts.
 *
 * If this file fails:
 * - You almost certainly broke the core invariant for notifications.
 * - Fix the logic in `src/watcher/run_watcher.js` (see `shouldNotifyMilestone` + usage in watchRun).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import watcher from "../../src/watcher/run_watcher.js";

const { getSplitWithClock, shouldNotifyMilestone } = watcher;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const world = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../fixtures/paceman_world_all_splits.json"),
    "utf8"
  )
);

const MILESTONES = [
  "nether",
  "bastion",
  "fortress",
  "first_portal",
  "second_portal",
  "stronghold",
  "end",
  "finish",
];

describe("core alert contract", () => {
  it("notifies for every milestone when split exists and is under cutoff (IGT)", () => {
    // Beginner summary: for each milestone, if Paceman provides a split time and it's under the cutoff,
    // we expect the watcher to trigger a notification.
    for (const m of MILESTONES) {
      const { ms } = getSplitWithClock(world, m, "IGT", "RTA");
      expect(ms).not.toBe(null);
      expect(
        shouldNotifyMilestone({
          ms,
          enabled: true,
          thresholdSec: 10_000,
          forceSend: false,
        })
      ).toBe(true);
    }
  });

  it("does not notify when disabled or missing", () => {
    // Disabled milestones should never notify; missing split times (null) should never notify.
    expect(
      shouldNotifyMilestone({ ms: 1000, enabled: false, thresholdSec: 10_000 })
    ).toBe(false);
    expect(
      shouldNotifyMilestone({ ms: null, enabled: true, thresholdSec: 10_000 })
    ).toBe(false);
  });

  it("disabled milestones suppress notifications even when time is under threshold", () => {
    // Critical: When enabled=false, notifications must be suppressed regardless of split time.
    // This is the core behavior that the UI toggle controls.
    const fastTime = 5000; // 5 seconds, well under any reasonable threshold
    const threshold = 10_000; // 10 seconds

    // Enabled milestone with fast time → should notify
    expect(
      shouldNotifyMilestone({
        ms: fastTime,
        enabled: true,
        thresholdSec: threshold,
        forceSend: false,
      })
    ).toBe(true);

    // Disabled milestone with same fast time → should NOT notify
    expect(
      shouldNotifyMilestone({
        ms: fastTime,
        enabled: false,
        thresholdSec: threshold,
        forceSend: false,
      })
    ).toBe(false);

    // Disabled milestone even with forceSend → should NOT notify (enabled check happens first)
    expect(
      shouldNotifyMilestone({
        ms: fastTime,
        enabled: false,
        thresholdSec: threshold,
        forceSend: true,
      })
    ).toBe(false);
  });

  it("respects cutoff when not forced", () => {
    // If split is slower than the cutoff, we should NOT notify unless forceSend is enabled.
    // 12 seconds >= cutoff 10 seconds => no notify
    expect(
      shouldNotifyMilestone({
        ms: 12_000,
        enabled: true,
        thresholdSec: 10,
        forceSend: false,
      })
    ).toBe(false);
    // force overrides cutoff
    expect(
      shouldNotifyMilestone({
        ms: 12_000,
        enabled: true,
        thresholdSec: 10,
        forceSend: true,
      })
    ).toBe(true);
  });

  it("disabled milestones NEVER send notifications (comprehensive check)", () => {
    // This test explicitly verifies that enabled=false means NO notifications, period.
    // This is the core contract: UI toggle off = no notifications, ever.
    const testCases = [
      { ms: 1000, thresholdSec: 10_000, forceSend: false }, // fast time, under threshold
      { ms: 1000, thresholdSec: 10_000, forceSend: true }, // fast time, force send
      { ms: 5000, thresholdSec: 10_000, forceSend: false }, // medium time, under threshold
      { ms: 5000, thresholdSec: 10_000, forceSend: true }, // medium time, force send
      { ms: 15_000, thresholdSec: 10_000, forceSend: false }, // slow time, over threshold
      { ms: 15_000, thresholdSec: 10_000, forceSend: true }, // slow time, force send
    ];

    for (const testCase of testCases) {
      // Every single case with enabled=false should return false
      expect(
        shouldNotifyMilestone({
          ...testCase,
          enabled: false,
        })
      ).toBe(false);
    }

    // But the same cases with enabled=true should work (for comparison)
    expect(
      shouldNotifyMilestone({
        ms: 1000,
        enabled: true,
        thresholdSec: 10_000,
        forceSend: false,
      })
    ).toBe(true);
    expect(
      shouldNotifyMilestone({
        ms: 1000,
        enabled: true,
        thresholdSec: 10_000,
        forceSend: true,
      })
    ).toBe(true);
  });
});
