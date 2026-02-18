/**
 * Dashboard “core flow” tests
 *
 * Goal: catch regressions in the 2 most important user actions:
 * - Load config (page boots)
 * - Add streamer (writes config and updates UI)
 *
 * We mock `fetch` because:
 * - These are unit-ish tests, not e2e.
 * - It keeps tests fast and deterministic.
 *
 * If this file fails:
 * - The dashboard may not load config correctly, or may not persist changes.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import App from "./App";

function mockFetchSequence(
  responses: Array<{ ok: boolean; status?: number; json: any }>
) {
  // Minimal fetch mock: each call returns the next response in the sequence.
  let i = 0;
  // @ts-expect-error - test mock
  globalThis.fetch = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json,
    };
  });
}

describe("App", () => {
  beforeEach(() => {
    // Reset mocks between tests so calls don’t bleed across test cases.
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Test: loads config and renders streamer tiles
  it("loads config and renders streamer tiles", async () => {
    // Contract: App calls GET /config on mount and renders the returned streamers.
    mockFetchSequence([
      {
        ok: true,
        json: {
          streamers: ["xQcOW"],
          clock: "IGT",
          quietHours: "00:30-07:15",
          defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
          profiles: {},
        },
      },
    ]);

    render(<App />);
    expect(await screen.findByText("xQcOW")).toBeTruthy();
    // Quiet Hours pill should exist (prominent entrypoint).
    expect(await screen.findByTestId("header-quietHours")).toBeTruthy();
  });

  // Test: add streamer uses default milestones (1 hour for debugging)
  it("add streamer uses default milestones (1 hour for debugging)", async () => {
    // Critical: New streamers should inherit defaultMilestones from config.
    // For debugging, all defaults are set to 3600 seconds (1 hour).
    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: {
        nether: { thresholdSec: 3600, enabled: true },
        bastion: { thresholdSec: 3600, enabled: true },
        fortress: { thresholdSec: 3600, enabled: true },
        first_portal: { thresholdSec: 3600, enabled: true },
        stronghold: { thresholdSec: 3600, enabled: true },
        end: { thresholdSec: 3600, enabled: true },
        finish: { thresholdSec: 3600, enabled: true },
      },
      profiles: {},
    };

    let savedCfg = structuredClone(initialCfg);
    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    vi.spyOn(window, "prompt").mockReturnValue("NewStreamer");

    render(<App />);
    await screen.findByText("xQcOW");

    const addBtn = document.querySelector(
      "button.avatarBtn.add"
    ) as HTMLButtonElement | null;
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);

    await waitFor(() => {
      expect(savedCfg.streamers).toContain("NewStreamer");
      // New streamer should NOT have a profile entry (inherits from defaults)
      expect(savedCfg.profiles?.NewStreamer).toBeUndefined();
    });

    // Verify the UI shows the new streamer with default milestones
    await screen.findByText("NewStreamer");

    // Open the new streamer's panel to verify milestones
    const newStreamerBtn = Array.from(
      document.querySelectorAll("div.avatarTile button.avatarBtn")
    ).find((btn) => {
      const tile = btn.closest(".avatarTile");
      return tile?.textContent?.includes("NewStreamer");
    }) as HTMLButtonElement | null;
    expect(newStreamerBtn).toBeTruthy();
    fireEvent.click(newStreamerBtn!);

    // Check that milestones show 60:00 (3600 seconds = 1 hour)
    const netherMinutes = await screen.findByLabelText("nether-minutes");
    expect((netherMinutes as HTMLInputElement).value).toBe("60");
    const netherSeconds = await screen.findByLabelText("nether-seconds");
    expect((netherSeconds as HTMLInputElement).value).toBe("00");
  });

  // Test: add streamer calls PUT /config then re-renders
  it("add streamer calls PUT /config then re-renders", async () => {
    // Beginner summary: adding a streamer should call PUT /config and show the new tile.
    vi.spyOn(window, "prompt").mockReturnValue("forsen");

    const initialCfg = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };
    const updatedCfg = { ...initialCfg, streamers: ["xQcOW", "forsen"] };

    // GET /config (initial), PUT /config, then GET /config (canonical)
    mockFetchSequence([
      { ok: true, json: initialCfg },
      { ok: true, json: { ok: true } },
      { ok: true, json: updatedCfg },
    ]);

    render(<App />);
    await screen.findByText("xQcOW");

    // The clickable element is the big plus button; avoid relying on label uniqueness.
    const addBtn = document.querySelector(
      "button.avatarBtn.add"
    ) as HTMLButtonElement | null;
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);

    expect(await screen.findByText("forsen")).toBeTruthy();
  });

  // Test: clicking the header Quiet Hours pill opens the Quiet Hours modal
  it("clicking the header Quiet Hours pill opens the Quiet Hours modal", async () => {
    mockFetchSequence([
      {
        ok: true,
        json: {
          streamers: ["xQcOW"],
          clock: "IGT",
          quietHours: "00:30-07:15",
          defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
          profiles: {},
        },
      },
    ]);

    render(<App />);
    await screen.findByText("xQcOW");

    fireEvent.click(await screen.findByTestId("header-quietHours"));
    expect(await screen.findByLabelText("Quiet hours")).toBeTruthy();
    expect(await screen.findByText(/keep monitoring runs/i)).toBeTruthy();
  });

  // Test: quiet hours editor saves an array of ranges (multi-span) and enforces max 3 spans
  it("quiet hours editor saves an array of ranges (multi-span) and enforces max 3 spans", async () => {
    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      // profiles/status best-effort
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open editor
    fireEvent.click(await screen.findByTestId("header-quietHours"));
    await screen.findByLabelText("Quiet hours");

    const addBtn = await screen.findByText(/Add span/i);
    // Add 3 spans (max)
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);

    // 4th click should not increase beyond max (button disabled)
    expect((addBtn as HTMLButtonElement).disabled).toBe(true);

    // Fill spans with valid times
    // Span 0: 9:00 PM -> 9:00 AM (wrap-around)
    fireEvent.change(await screen.findByLabelText("quiet-0-start-hour"), {
      target: { value: "9" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-ampm"), {
      target: { value: "PM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-hour"), {
      target: { value: "9" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-ampm"), {
      target: { value: "AM" },
    });

    // Span 1: 12:00 PM -> 2:00 PM
    fireEvent.change(await screen.findByLabelText("quiet-1-start-hour"), {
      target: { value: "12" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-start-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-start-ampm"), {
      target: { value: "PM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-end-hour"), {
      target: { value: "2" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-end-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-end-ampm"), {
      target: { value: "PM" },
    });

    // Span 2: 6:15 AM -> 7:45 AM
    fireEvent.change(await screen.findByLabelText("quiet-2-start-hour"), {
      target: { value: "6" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-2-start-minute"), {
      target: { value: "15" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-2-start-ampm"), {
      target: { value: "AM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-2-end-hour"), {
      target: { value: "7" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-2-end-minute"), {
      target: { value: "45" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-2-end-ampm"), {
      target: { value: "AM" },
    });

    fireEvent.click(await screen.findByText("Save"));

    await waitFor(() => {
      expect(savedCfg.quietHours).toEqual([
        "21:00-09:00",
        "12:00-14:00",
        "06:15-07:45",
      ]);
    });
  });

  // Test: quiet hours editor blocks invalid entries (start=end)
  it("quiet hours editor blocks invalid entries (start=end)", async () => {
    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    let putCalls = 0;
    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => initialCfg };
      }
      if (u.includes("/config") && method === "PUT") {
        putCalls++;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    fireEvent.click(await screen.findByTestId("header-quietHours"));
    await screen.findByLabelText("Quiet hours");

    const addBtn = await screen.findByText(/Add span/i);
    fireEvent.click(addBtn);

    // Set start=end 9:00 AM -> 9:00 AM
    fireEvent.change(await screen.findByLabelText("quiet-0-start-hour"), {
      target: { value: "9" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-ampm"), {
      target: { value: "AM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-hour"), {
      target: { value: "9" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-ampm"), {
      target: { value: "AM" },
    });

    fireEvent.click(await screen.findByText("Save"));
    expect(await screen.findByText(/start and end cannot be the same/i)).toBeTruthy();
    expect(putCalls).toBe(0);
  });

  // Test: quiet hours editor blocks incomplete/invalid inputs
  it("quiet hours editor blocks incomplete/invalid inputs", async () => {
    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    let putCalls = 0;
    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => initialCfg };
      }
      if (u.includes("/config") && method === "PUT") {
        putCalls++;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    fireEvent.click(await screen.findByTestId("header-quietHours"));
    await screen.findByLabelText("Quiet hours");

    const addBtn = await screen.findByText(/Add span/i);
    fireEvent.click(addBtn);

    // Test incomplete: missing minute
    fireEvent.change(await screen.findByLabelText("quiet-0-start-hour"), {
      target: { value: "9" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-minute"), {
      target: { value: "" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-ampm"), {
      target: { value: "AM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-hour"), {
      target: { value: "10" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-ampm"), {
      target: { value: "AM" },
    });

    fireEvent.click(await screen.findByText("Save"));
    expect(await screen.findByText(/incomplete or invalid/i)).toBeTruthy();
    expect(putCalls).toBe(0);
  });

  // Test: quiet hours editor allows overlapping spans (overlaps are fine)
  it("quiet hours editor allows overlapping spans (overlaps are fine)", async () => {
    // Overlaps are allowed - they just mean "quiet if in ANY span"
    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    let savedCfg = structuredClone(initialCfg);
    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    fireEvent.click(await screen.findByTestId("header-quietHours"));
    await screen.findByLabelText("Quiet hours");

    const addBtn = await screen.findByText(/Add span/i);
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);

    // Span 0: 10:00 AM -> 2:00 PM
    fireEvent.change(await screen.findByLabelText("quiet-0-start-hour"), {
      target: { value: "10" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-ampm"), {
      target: { value: "AM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-hour"), {
      target: { value: "2" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-ampm"), {
      target: { value: "PM" },
    });

    // Span 1: 12:00 PM -> 4:00 PM (overlaps with span 0)
    fireEvent.change(await screen.findByLabelText("quiet-1-start-hour"), {
      target: { value: "12" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-start-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-start-ampm"), {
      target: { value: "PM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-end-hour"), {
      target: { value: "4" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-end-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-1-end-ampm"), {
      target: { value: "PM" },
    });

    fireEvent.click(await screen.findByText("Save"));

    await waitFor(() => {
      expect(savedCfg.quietHours).toEqual([
        "10:00-14:00",
        "12:00-16:00",
      ]);
    });
  });

  // Test: quiet hours editor handles midnight edge cases correctly
  it("quiet hours editor handles midnight edge cases correctly", async () => {
    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    let savedCfg = structuredClone(initialCfg);
    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    fireEvent.click(await screen.findByTestId("header-quietHours"));
    await screen.findByLabelText("Quiet hours");

    const addBtn = await screen.findByText(/Add span/i);
    fireEvent.click(addBtn);

    // Test 12:00 AM (midnight) -> 12:00 PM (noon) wrap
    fireEvent.change(await screen.findByLabelText("quiet-0-start-hour"), {
      target: { value: "12" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-start-ampm"), {
      target: { value: "AM" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-hour"), {
      target: { value: "12" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-minute"), {
      target: { value: "00" },
    });
    fireEvent.change(await screen.findByLabelText("quiet-0-end-ampm"), {
      target: { value: "PM" },
    });

    fireEvent.click(await screen.findByText("Save"));

    await waitFor(() => {
      expect(savedCfg.quietHours).toEqual(["00:00-12:00"]);
    });
  });

  // Test: quiet hours editor allows empty array (no quiet hours)
  it("quiet hours editor allows empty array (no quiet hours)", async () => {
    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: ["21:00-09:00"],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    let savedCfg = structuredClone(initialCfg);
    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    fireEvent.click(await screen.findByTestId("header-quietHours"));
    await screen.findByLabelText("Quiet hours");

    // Remove the existing span
    const removeBtn = await screen.findByText("Remove");
    fireEvent.click(removeBtn);

    fireEvent.click(await screen.findByText("Save"));

    await waitFor(() => {
      expect(savedCfg.quietHours).toEqual([]);
    });
  });

  // Test: blocks Add Streamer when max streamers reached
  it("blocks Add Streamer when max streamers reached", async () => {
    const streamers = Array.from({ length: 15 }, (_, i) => `s${i}`);
    const cfg: any = {
      streamers,
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("extra");

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => cfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("s0");

    const addBtn = document.querySelector(
      "button.avatarBtn.add"
    ) as HTMLButtonElement | null;
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);

    // Should not even prompt when max is reached.
    expect(promptSpy).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/Max streamers reached \(15\)/)
    ).toBeTruthy();
  });

  // Test: edits milestone cutoff via minutes+seconds and persists thresholdSec in seconds
  it("edits milestone cutoff via minutes+seconds and persists thresholdSec in seconds", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    const mmInput = await screen.findByLabelText("nether-minutes");
    const ssInput = await screen.findByLabelText("nether-seconds");

    fireEvent.change(mmInput, { target: { value: "4" } });
    fireEvent.change(ssInput, { target: { value: "50" } });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(savedCfg.profiles?.xQcOW?.nether?.thresholdSec).toBe(290);
    });
  });

  // Test: toggles milestone enabled state and persists it
  it("toggles milestone enabled state and persists it", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: {
        nether: { thresholdSec: 240, enabled: true },
        bastion: { thresholdSec: 600, enabled: true },
      },
      profiles: {
        xQcOW: {
          nether: { thresholdSec: 240, enabled: true },
          bastion: { thresholdSec: 600, enabled: true },
        },
      },
    };

    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    // Find the nether checkbox - it's in a label with "on" text, near the milestone name
    const netherRow = await screen.findByText("Nether").then((el) =>
      el.closest(".milestoneRow")
    );
    expect(netherRow).toBeTruthy();
    const netherCheckbox = netherRow?.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    expect(netherCheckbox).toBeTruthy();
    expect(netherCheckbox.checked).toBe(true);

    // Toggle it off
    fireEvent.click(netherCheckbox);
    await waitFor(() => {
      expect((netherCheckbox as HTMLInputElement).checked).toBe(false);
    });

    // Save manually
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(savedCfg.profiles?.xQcOW?.nether?.enabled).toBe(false);
      // Threshold should remain unchanged
      expect(savedCfg.profiles?.xQcOW?.nether?.thresholdSec).toBe(240);
    });

    // Toggle bastion off too
    const bastionRow = await screen.findByText("Bastion").then((el) =>
      el.closest(".milestoneRow")
    );
    expect(bastionRow).toBeTruthy();
    const bastionCheckbox = bastionRow?.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    expect(bastionCheckbox).toBeTruthy();
    fireEvent.click(bastionCheckbox);
    await waitFor(() => {
      expect(bastionCheckbox.checked).toBe(false);
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(savedCfg.profiles?.xQcOW?.bastion?.enabled).toBe(false);
    });

    // Toggle nether back on - need to re-find the checkbox after state updates
    const netherRowAfter = await screen.findByText("Nether").then((el) =>
      el.closest(".milestoneRow")
    );
    const netherCheckboxAfter = netherRowAfter?.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    fireEvent.click(netherCheckboxAfter);
    await waitFor(() => {
      expect(netherCheckboxAfter.checked).toBe(true);
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(savedCfg.profiles?.xQcOW?.nether?.enabled).toBe(true);
    }, { timeout: 2000 });
  });

  // Test: toggles milestone enabled state with autosave (debounced)
  it("toggles milestone enabled state with autosave (debounced)", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {
        xQcOW: {
          nether: { thresholdSec: 240, enabled: true },
        },
      },
    };

    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    const netherRow = await screen.findByText("Nether").then((el) =>
      el.closest(".milestoneRow")
    );
    expect(netherRow).toBeTruthy();
    const netherCheckbox = netherRow?.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    expect(netherCheckbox).toBeTruthy();
    expect(netherCheckbox.checked).toBe(true);

    // Switch to fake timers for debounce
    vi.useFakeTimers();

    // Toggle off
    fireEvent.click(netherCheckbox);
    expect((netherCheckbox as HTMLInputElement).checked).toBe(false);

    // Advance time to trigger autosave (700ms debounce)
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    await Promise.resolve();

    expect(savedCfg.profiles?.xQcOW?.nether?.enabled).toBe(false);

    vi.useRealTimers();
  });

  // Test: disabled milestones show reduced opacity in UI
  it("disabled milestones show reduced opacity in UI", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: [],
      defaultMilestones: {
        nether: { thresholdSec: 240, enabled: false },
        bastion: { thresholdSec: 600, enabled: true },
      },
      profiles: {
        xQcOW: {
          nether: { thresholdSec: 240, enabled: false },
          bastion: { thresholdSec: 600, enabled: true },
        },
      },
    };

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => initialCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    const netherRow = await screen.findByText("Nether").then((el) =>
      el.closest(".milestoneRow")
    );
    const bastionRow = await screen.findByText("Bastion").then((el) =>
      el.closest(".milestoneRow")
    );
    expect(netherRow).toBeTruthy();
    expect(bastionRow).toBeTruthy();

    const netherCheckbox = netherRow?.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    const bastionCheckbox = bastionRow?.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;

    // Nether should be unchecked (disabled)
    expect(netherCheckbox.checked).toBe(false);
    // Bastion should be checked (enabled)
    expect(bastionCheckbox.checked).toBe(true);

    expect(netherRow).toBeTruthy();
    expect(bastionRow).toBeTruthy();

    // Disabled milestone should have reduced opacity (0.55)
    expect((netherRow as HTMLElement).style.opacity).toBe("0.55");
    // Enabled milestone should have full opacity (1)
    expect((bastionRow as HTMLElement).style.opacity).toBe("1");
  });

  // Test: autosaves milestone edits after a short pause (debounced)
  it("autosaves milestone edits after a short pause (debounced)", async () => {
    // Beginner summary: as you type, the app should auto-save after you stop typing briefly.
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };
    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    const mmInput = await screen.findByLabelText("nether-minutes");
    const ssInput = await screen.findByLabelText("nether-seconds");

    // Switch to fake timers only for the debounce window (700ms).
    vi.useFakeTimers();

    fireEvent.change(mmInput, { target: { value: "5" } });
    fireEvent.change(ssInput, { target: { value: "01" } });

    // Debounce window is 700ms (see App.tsx). Advance time to trigger autosave.
    await vi.advanceTimersByTimeAsync(750);
    // Let the async save promise chain resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(savedCfg.profiles?.xQcOW?.nether?.thresholdSec).toBe(301);
  });

  // Test: pressing Enter in a time input saves immediately (no debounce)
  it("pressing Enter in a time input saves immediately (no debounce)", async () => {
    // Beginner summary: Enter should force-save right away, even if the debounce timer hasn't fired.
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };
    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    const mmInput = await screen.findByLabelText("nether-minutes");
    const ssInput = await screen.findByLabelText("nether-seconds");

    fireEvent.change(mmInput, { target: { value: "6" } });
    fireEvent.change(ssInput, { target: { value: "00" } });

    // Hit Enter to force-save immediately
    fireEvent.keyDown(ssInput, { key: "Enter", code: "Enter", charCode: 13 });

    await waitFor(() => {
      expect(savedCfg.profiles?.xQcOW?.nether?.thresholdSec).toBe(360);
    });
  });

  // Test: close + reopen streamer panel shows the persisted values (autosave path)
  it("close + reopen streamer panel shows the persisted values (autosave path)", async () => {
    // Beginner summary: after autosave, closing and reopening the panel should show the saved cutoff.
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };
    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    const mmInput = await screen.findByLabelText("nether-minutes");
    const ssInput = await screen.findByLabelText("nether-seconds");

    vi.useFakeTimers();
    fireEvent.change(mmInput, { target: { value: "7" } });
    fireEvent.change(ssInput, { target: { value: "05" } });
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    await Promise.resolve();

    expect(savedCfg.profiles?.xQcOW?.nether?.thresholdSec).toBe(425);

    // Switch back to real timers before doing async queries / UI transitions.
    vi.useRealTimers();

    // Close and re-open; the UI should still show 7:05.
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(streamerBtn!);

    const mm2 = await screen.findByLabelText("nether-minutes");
    const ss2 = await screen.findByLabelText("nether-seconds");
    expect((mm2 as HTMLInputElement).value).toBe("7");
    expect((ss2 as HTMLInputElement).value).toBe("05");
  });

  // Test: close + reopen streamer panel shows the persisted values (Enter path)
  it("close + reopen streamer panel shows the persisted values (Enter path)", async () => {
    // Beginner summary: after hitting Enter, closing and reopening should show the saved cutoff.
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const initialCfg: any = {
      streamers: ["xQcOW"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };
    let savedCfg = structuredClone(initialCfg);

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      if (u.includes("/config") && method === "PUT") {
        savedCfg = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => savedCfg };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("xQcOW");

    // Open streamer panel
    const streamerBtn = document.querySelector(
      "div.avatarTile button.avatarBtn"
    ) as HTMLButtonElement | null;
    expect(streamerBtn).toBeTruthy();
    fireEvent.click(streamerBtn!);

    const mmInput = await screen.findByLabelText("nether-minutes");
    const ssInput = await screen.findByLabelText("nether-seconds");

    fireEvent.change(mmInput, { target: { value: "8" } });
    fireEvent.change(ssInput, { target: { value: "00" } });
    fireEvent.keyDown(ssInput, { key: "Enter", code: "Enter", charCode: 13 });

    await waitFor(() => {
      expect(savedCfg.profiles?.xQcOW?.nether?.thresholdSec).toBe(480);
    });

    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(streamerBtn!);

    const mm2 = await screen.findByLabelText("nether-minutes");
    const ss2 = await screen.findByLabelText("nether-seconds");
    expect((mm2 as HTMLInputElement).value).toBe("8");
    expect((ss2 as HTMLInputElement).value).toBe("00");
  });

  // Test: renders per-streamer milestone badges only when active, and none on Add Streamer
  it("renders per-streamer milestone badges only when active, and none on Add Streamer", async () => {
    // Beginner summary: tiles should show a breathing milestone badge only when the runner is active and has hit a split.
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const cfg: any = {
      streamers: ["xQcOW", "forsen"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();

      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => cfg };
      }

      if (u.includes("/profiles?names=") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            profiles: {
              xQcOW: { avatarUrl: "https://example.com/xqc.png" },
              forsen: { avatarUrl: null },
            },
          }),
        };
      }

      if (u.includes("/status?names=") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            statuses: {
              xQcOW: {
                runId: 1,
                isLive: false,
                isActive: true,
                runIsActive: true,
                lastMilestone: "nether",
                lastMilestoneMs: 485_000,
                runStartSec: Math.floor(Date.now() / 1000) - 600,
              },
              forsen: {
                runId: 2,
                isLive: false,
                isActive: false,
                runIsActive: false,
                lastMilestone: "nether",
              },
            },
          }),
        };
      }

      // Other endpoints (notify, milestones, config PUT) are not under test here.
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);

    await screen.findByText("xQcOW");
    await screen.findByText("forsen");

    const xAvatar = await screen.findByAltText("xQcOW avatar");
    expect((xAvatar as HTMLImageElement).src).toContain(
      "https://example.com/xqc.png"
    );

    const xBadge = await screen.findByLabelText("xQcOW-milestone");
    expect((xBadge as HTMLElement).textContent || "").toContain("Nether");
    expect((xBadge as HTMLElement).className).toContain("live");
    expect((xBadge as HTMLElement).getAttribute("title") || "").toContain(
      "Nether: 8:05"
    );

    // Inactive runners should not show a milestone badge (even if lastMilestone exists).
    expect(screen.queryByLabelText("forsen-milestone")).toBeNull();

    // Add Streamer tile should never render a badge.
    const addBadge = document.querySelector(
      "button.avatarBtn.add .milestoneBadge"
    );
    expect(addBadge).toBeNull();
  });

  // Test: renders Finish as a gold, non-pulsing badge with a minimal tooltip
  it("renders Finish as a gold, non-pulsing badge with a minimal tooltip", async () => {
    // Beginner summary: finish should look final (gold + no breathing), and show finish time + recency on hover.
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const cfg: any = {
      streamers: ["Couriway"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();

      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => cfg };
      }

      if (u.includes("/profiles?names=") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            profiles: {
              Couriway: { avatarUrl: "https://example.com/couri.png" },
            },
          }),
        };
      }

      if (u.includes("/status?names=") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            statuses: {
              Couriway: {
                runId: 1,
                isLive: false,
                isActive: true,
                runIsActive: true,
                lastMilestone: "finish",
                lastMilestoneMs: 1179_799,
                lastUpdatedSec: Math.floor(Date.now() / 1000) - 65,
              },
            },
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("Couriway");

    const avatar = await screen.findByAltText("Couriway avatar");
    expect((avatar as HTMLImageElement).src).toContain(
      "https://example.com/couri.png"
    );

    const badge = await screen.findByLabelText("Couriway-milestone");
    expect((badge as HTMLElement).textContent || "").toContain("Finish");
    expect((badge as HTMLElement).className).toContain("final");
    expect((badge as HTMLElement).getAttribute("title") || "").toContain(
      "Finish:"
    );
  });

  // Test: shows Finish briefly even if a new run started immediately (finish grace)
  it("shows Finish briefly even if a new run started immediately (finish grace)", async () => {
    // Beginner summary: if a runner insta-starts a new run, we still want a short Finish badge moment.
    vi.spyOn(window, "prompt").mockReturnValue(null);

    const cfg: any = {
      streamers: ["Couriway"],
      clock: "IGT",
      quietHours: "00:30-07:15",
      defaultMilestones: { nether: { thresholdSec: 240, enabled: true } },
      profiles: {},
    };

    // @ts-expect-error - test mock
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();

      if (u.includes("/config") && method === "GET") {
        return { ok: true, status: 200, json: async () => cfg };
      }

      if (u.includes("/profiles?names=") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            profiles: { Couriway: { avatarUrl: null } },
          }),
        };
      }

      if (u.includes("/status?names=") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            statuses: {
              Couriway: {
                runId: 100,
                isLive: true,
                isActive: true,
                runIsActive: true,
                lastMilestone: "end",
                lastMilestoneMs: 1_139_011,
                lastUpdatedSec: Math.floor(Date.now() / 1000) - 5,
                recentFinishMs: 1_207_856,
                recentFinishUpdatedSec: Math.floor(Date.now() / 1000) - 65,
              },
            },
          }),
        };
      }

      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    render(<App />);
    await screen.findByText("Couriway");

    const badge = await screen.findByLabelText("Couriway-milestone");
    expect((badge as HTMLElement).textContent || "").toContain("Finish");
    expect((badge as HTMLElement).className).toContain("final");
  });
});
