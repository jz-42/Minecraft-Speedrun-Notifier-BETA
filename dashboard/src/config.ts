// dashboard/src/config.ts
//
// Canonical milestone keys we support in the UI.
// These map directly to Paceman `getWorld` split keys:
// - IGT: bare key (e.g. "nether")
// - RTA: "<key>Rta" (e.g. "netherRta")
// Ref: https://paceman.gg/stats/api/ (getWorld)

export const CANONICAL_MILESTONES = [
  "nether",
  "bastion",
  "fortress",
  "first_portal",
  "second_portal",
  "stronghold",
  "end",
  "finish",
] as const;

export type CanonicalMilestone = (typeof CANONICAL_MILESTONES)[number];

export function milestoneLabel(m: string) {
  return m.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
