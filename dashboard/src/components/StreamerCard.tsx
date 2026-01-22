import React from "react";

type MilestoneConfig = {
  thresholdSec?: number;
  enabled?: boolean;
};

type StreamerCardProps = {
  name: string;
  milestones: Record<string, MilestoneConfig>;
};

function formatSeconds(sec?: number) {
  if (sec == null) return "∞";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export const StreamerCard: React.FC<StreamerCardProps> = ({ name, milestones }) => {
  return (
    <div
      style={{
        borderRadius: "16px",
        padding: "16px",
        border: "1px solid #333",
        background: "#111",
        color: "#f5f5f5",
        minWidth: "260px"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ fontSize: "1.1rem", fontWeight: 600 }}>{name}</h2>
        {/* future: green/red bubble */}
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "999px",
            background: "#555"
          }}
        />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {Object.entries(milestones).map(([milestone, cfg]) => {
          const enabled = cfg.enabled ?? true;
          const label = `${milestone} < ${formatSeconds(cfg.thresholdSec)}`;
          return (
            <span
              key={milestone}
              style={{
                fontSize: "0.8rem",
                padding: "4px 8px",
                borderRadius: "999px",
                border: "1px solid #444",
                opacity: enabled ? 1 : 0.4
              }}
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
};
