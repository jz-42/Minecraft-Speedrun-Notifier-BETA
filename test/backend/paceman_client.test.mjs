/**
 * Paceman parsing unit tests
 *
 * Why these exist:
 * - We previously had a bug where IGT was read from `netherIgt`, but Paceman `getWorld` uses bare keys for IGT (`nether`).
 * - This file locks in the IGT vs RTA contract so refactors can't silently break notifications.
 *
 * Uses a local JSON fixture (no network) to stay deterministic.
 *
 * If this file fails:
 * - We may be reading the wrong Paceman fields (IGT vs RTA).
 * - That can silently break all notifications (milestones never “exist”).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import client from "../../src/paceman/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const world = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../fixtures/paceman_world_xqc.json"),
    "utf8"
  )
);

const { getSplitMs } = client;

describe("paceman/client.getSplitMs", () => {
  it("reads IGT from bare keys (e.g. nether)", () => {
    // Beginner summary: on Paceman `getWorld`, IGT uses bare keys like `data.nether`.
    expect(getSplitMs(world, "nether", "IGT")).toBe(179852);
  });

  it("reads RTA from <base>Rta keys (e.g. netherRta)", () => {
    // Beginner summary: RTA uses a `Rta` suffix like `data.netherRta`.
    expect(getSplitMs(world, "nether", "RTA")).toBe(181812);
  });

  it("returns null for missing splits", () => {
    // Beginner summary: if Paceman doesn't have a split yet, treat it as missing (null), not 0.
    expect(getSplitMs(world, "bastion", "IGT")).toBe(null);
    expect(getSplitMs(world, "bastion", "RTA")).toBe(null);
  });

  it("handles camelCase split keys when base is snake_case", () => {
    const camelWorld = {
      data: {
        firstPortal: 191000,
        firstPortalRta: 195000,
      },
    };

    expect(getSplitMs(camelWorld, "first_portal", "IGT")).toBe(191000);
    expect(getSplitMs(camelWorld, "first_portal", "RTA")).toBe(195000);
  });
});
