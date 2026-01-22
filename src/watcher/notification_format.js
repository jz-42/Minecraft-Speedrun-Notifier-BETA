// Notification formatting helpers (kept separate so `run_watcher.js` stays readable).

function msToMMSS(ms) {
  if (ms == null) return "—";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function milestonePrettyLabel(milestone) {
  switch (milestone) {
    case "nether":
      return "Nether";
    case "bastion":
      return "Bastion";
    case "fortress":
      return "Fortress";
    case "first_portal":
      return "First Portal";
    case "stronghold":
      return "Stronghold";
    case "end":
      return "End";
    case "finish":
      return "Finish";
    default: {
      const s = String(milestone || "").trim();
      if (!s) return "Milestone";
      return s
        .split("_")
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() + w.slice(1))
        .join(" ");
    }
  }
}

function milestoneEnteredLabel(milestone) {
  // Notification copy preference:
  // - Most milestones read better as "Entered X"
  // - Except: First Portal, Finish (keep as plain labels)
  const label = milestonePrettyLabel(milestone);
  if (milestone === "first_portal") return label;
  if (milestone === "finish") return label;
  return `Entered ${label}`;
}

function milestoneEmoji(milestone) {
  // Emoji palette (purely cosmetic).
  switch (milestone) {
    case "nether":
      return "🔥";
    case "bastion":
      return "🟨🐷";
    case "fortress":
      return "🏰🧱";
    case "first_portal":
      return "🌀✨";
    case "stronghold":
      return "👁️";
    case "end":
      return "🐉";
    case "finish":
      return "👑";
    default:
      return null;
  }
}

function formatNotificationTitle({ milestone, splitMs, streamer }) {
  // Keep the title short and clean (avoid truncation).
  // Example: "First Portal 🌀✨ — 3:12 (xQcOW)"
  const label = milestonePrettyLabel(milestone);
  const emoji = milestoneEmoji(milestone);
  const time = msToMMSS(splitMs);
  const who = String(streamer || "").trim() || "Unknown";
  return `${label}${emoji ? ` ${emoji}` : ""} — ${time} (${who})`;
}

module.exports = {
  msToMMSS,
  milestonePrettyLabel,
  milestoneEnteredLabel,
  milestoneEmoji,
  formatNotificationTitle,
};
