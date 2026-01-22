type Props = {
  label: string;
  variant?: "profile" | "add";
  status?: "active" | "disabled" | "offline";
  onClick?: () => void;
};

const STATUS_COLOR: Record<NonNullable<Props["status"]>, string> = {
  active: "#6CFF5F",
  offline: "#9aa0a6",
  disabled: "#D84B4B",
};

export function ProfileTile({
  label,
  variant = "profile",
  status = "active",
  onClick,
}: Props) {
  return (
    <button className="tile" onClick={onClick} type="button">
      <div className={`avatar ${variant === "add" ? "avatarAdd" : ""}`}>
        {variant === "add" ? <span className="plus">+</span> : null}
        <span
          className="statusDot"
          style={{ background: STATUS_COLOR[status] }}
        />
      </div>
      <div className="tileLabel">{label}</div>
    </button>
  );
}
