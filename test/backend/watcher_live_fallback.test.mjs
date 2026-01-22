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

  it("falls back to live-run events when getWorld is missing", () => {
    const world = { data: { end: null } };
    const liveRun = {
      eventList: [{ eventId: "rsg.enter_end", igt: 9000, rta: 10000 }],
    };

    const res = getSplitWithLiveFallback(world, liveRun, "end", "IGT", "RTA");

    expect(res).toEqual({ ms: 9000, usedClock: "IGT", source: "live" });
  });

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

  it("maps second_portal to rsg.second_portal", () => {
    const world = { data: {} };
    const liveRun = {
      eventList: [{ eventId: "rsg.second_portal", igt: 8000, rta: 8500 }],
    };

    const res = getSplitWithLiveFallback(
      world,
      liveRun,
      "second_portal",
      "IGT",
      "RTA"
    );

    expect(res).toEqual({ ms: 8000, usedClock: "IGT", source: "live" });
  });

  it("matches live runs using world nickname when streamer is a twitch handle", () => {
    const liveRuns = [{ nickname: "xQcOW" }, { nickname: "SomeoneElse" }];
    const match = findLiveRunForStreamer(liveRuns, ["xqc", "xQcOW"]);

    expect(match).toEqual({ nickname: "xQcOW" });
  });
});
