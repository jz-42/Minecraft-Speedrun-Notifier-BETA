/**
 * Live-run fallback tests
 *
 * These ensure we can read late/live milestones via Paceman's live runs API
 * when getWorld has missing splits.
 */

import { describe, it, expect } from "vitest";

import watcher from "../../src/watcher/run_watcher.js";

const { getSplitWithLiveFallback, findLiveRunForStreamer } = watcher;

describe("watcher live-run fallback", () => {
  // Test: prefers getWorld when split exists
  it("prefers getWorld when split exists", () => {
    const world = { data: { nether: 1000, netherRta: 1100 } };
    const liveRun = {
      eventList: [{ eventId: "rsg.enter_nether", igt: 2000, rta: 2100 }],
    };

    const res = getSplitWithLiveFallback(
      world,
      liveRun,
      "nether",
      "IGT",
      "RTA"
    );

    expect(res).toEqual({ ms: 1000, usedClock: "IGT", source: "world" });
  });

  // Test: falls back to live-run events when getWorld is missing
  it("falls back to live-run events when getWorld is missing", () => {
    const world = { data: { end: null } };
    const liveRun = {
      eventList: [{ eventId: "rsg.enter_end", igt: 9000, rta: 10000 }],
    };

    const res = getSplitWithLiveFallback(world, liveRun, "end", "IGT", "RTA");

    expect(res).toEqual({ ms: 9000, usedClock: "IGT", source: "live" });
  });

  // Test: handles finish via rsg.credits
  it("handles finish via rsg.credits", () => {
    const world = { data: {} };
    const liveRun = {
      eventList: [{ eventId: "rsg.credits", igt: 12000, rta: 13000 }],
    };

    const res = getSplitWithLiveFallback(
      world,
      liveRun,
      "finish",
      "IGT",
      "RTA"
    );

    expect(res).toEqual({ ms: 12000, usedClock: "IGT", source: "live" });
  });

  // Test: matches live runs using world nickname when streamer is a twitch handle
  it("matches live runs using world nickname when streamer is a twitch handle", () => {
    const liveRuns = [{ nickname: "xQcOW" }, { nickname: "SomeoneElse" }];
    const match = findLiveRunForStreamer(liveRuns, ["xqc", "xQcOW"]);

    expect(match).toEqual({ nickname: "xQcOW" });
  });
});
