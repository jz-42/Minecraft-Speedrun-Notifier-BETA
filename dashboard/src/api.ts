const API_BASE =
  typeof import.meta.env.VITE_API_BASE === "string" &&
  import.meta.env.VITE_API_BASE.trim().length > 0
    ? import.meta.env.VITE_API_BASE
    : "";

export async function getConfig() {
  const r = await fetch(`${API_BASE}/config`);
  if (!r.ok) throw new Error(`GET /config ${r.status}`);
  return r.json();
}

export async function putConfig(cfg: unknown) {
  const r = await fetch(`${API_BASE}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) throw new Error(`PUT /config ${r.status}`);

  // Don't trust PUT response shape — re-fetch canonical config
  return getConfig();
}

export async function testNotify(title?: string, message?: string) {
  const r = await fetch(`${API_BASE}/notify/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, message }),
  });
  if (!r.ok) throw new Error(`POST /notify/test ${r.status}`);
  return r.json();
}

export async function getPacemanMilestones(name: string) {
  const r = await fetch(
    `${API_BASE}/paceman/milestones?name=${encodeURIComponent(name)}`
  );
  if (!r.ok) throw new Error(`GET /paceman/milestones ${r.status}`);
  return r.json() as Promise<{ ok: boolean; runId: number | null; milestones: string[] }>;
}

export async function getProfiles(names: string[]) {
  const unique = Array.from(
    new Set(names.map((n) => String(n || "").trim()).filter(Boolean))
  );
  if (!unique.length) return { ok: true, profiles: {} as Record<string, any> };

  const r = await fetch(
    `${API_BASE}/profiles?names=${encodeURIComponent(unique.join(","))}`
  );
  if (!r.ok) throw new Error(`GET /profiles ${r.status}`);
  const body = await r.json();
  const profiles =
    body && typeof body === "object" && body.profiles && typeof body.profiles === "object"
      ? body.profiles
      : {};
  return { ok: true, profiles } as {
    ok: true;
    profiles: Record<
      string,
      {
        runId: number | null;
        twitch: string | null;
        uuid: string | null;
        avatarUrl: string | null;
      }
    >;
  };
}

export async function getStatuses(names: string[]) {
  const unique = Array.from(
    new Set(names.map((n) => String(n || "").trim()).filter(Boolean))
  );
  if (!unique.length) return { ok: true, statuses: {} as Record<string, any> };

  const r = await fetch(
    `${API_BASE}/status?names=${encodeURIComponent(unique.join(","))}`
  );
  if (!r.ok) throw new Error(`GET /status ${r.status}`);
  const body = await r.json();
  const statuses =
    body && typeof body === "object" && body.statuses && typeof body.statuses === "object"
      ? body.statuses
      : {};
  return { ok: true, statuses } as {
    ok: true;
    statuses: Record<
      string,
      {
        runId: number | null;
        isLive: boolean;
        isActive?: boolean;
        runIsActive?: boolean;
        lastUpdatedSec?: number | null;
        runStartSec?: number | null;
        lastMilestone?: string | null;
        lastMilestoneMs?: number | null;
        recentFinishMs?: number | null;
        recentFinishUpdatedSec?: number | null;
      }
    >;
  };
}
