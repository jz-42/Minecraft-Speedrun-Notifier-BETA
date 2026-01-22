type Props = {
  open: boolean;
  onClose: () => void;
};

export function SettingsModal({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="settingsModal" onClick={(e) => e.stopPropagation()}>
        <div className="settingsHeader">
          <h2>Settings</h2>
          <button className="closeBtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="settingsBody">
          <button className="settingsRow">Quiet Hours</button>
          <button className="settingsRow">Notification Type</button>
        </div>
      </div>
    </div>
  );
}