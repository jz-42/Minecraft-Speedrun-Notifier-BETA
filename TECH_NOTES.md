# Minecraft Speedrun Notifier (WIP) - SUPER ALPHA

## What it does

- Monitors selected streamers' Minecraft runs via paceman.gg JSON API.
- Tracks milestones (Nether, Stronghold, etc.).
- Applies per-streamer pace profiles (different cutoffs per runner).
- Sends desktop notifications when pace is fast enough.

## How to run (dev)

- Watcher + API (this is what you run to actually get alerts):
  - `node src/watcher/run_watcher.js --debug=1 --no-quiet`
- Dashboard (optional, for editing `config.json` live):
  - In another terminal: `cd dashboard && npm run dev`
  - The dashboard talks to the watcher’s API at `http://localhost:8787`

Edit `config.json` (via dashboard or manually):

- `"streamers"` → list of runner names (e.g. `xQcOW`)
  - `"defaultMilestones"` → global cutoffs
  - `"profiles"` → per-streamer overrides

## Tonight runbook (xQc)

1) Start watcher (sends desktop notifications):
   - `node src/watcher/run_watcher.js --debug=1 --no-quiet`
2) Start dashboard (optional):
   - `cd dashboard && npm run dev`
3) Open dashboard, click **Test desktop notification** once (verifies macOS notification permission).
4) Click xQc, set thresholds you care about, hit **Save**.

## Notifications UX notes (macOS)

- **Open stream from notification**: clicking the notification (or the **Open Stream** action when available) will open the streamer’s Twitch page.
- **“Linger until dismissed”**: macOS controls banner duration at the OS level. For truly sticky notifications, set this app’s notification style to **Alerts** in System Settings → Notifications.

## Next steps

- Add Discord / SMS channels via `notify` router.
- Basic web dashboard for configuring profiles.
- Package as a tray app / background service.

## Background watcher (pm2, macOS Step 1)

Goal: run the watcher invisibly on login, pulling config from the hosted dashboard.

1) Install pm2 (one-time):
   - `npm install -g pm2`
2) Start the watcher with the provided pm2 config:
   - `pm2 start ecosystem.config.cjs`
3) Save the process list (so it comes back on reboot):
   - `pm2 save`
4) Enable pm2 auto-start:
   - `pm2 startup`
   - Follow the printed command for macOS.
5) Check status/logs:
   - `pm2 status`
   - `pm2 logs runalert-watcher`

To stop it:
- `pm2 stop runalert-watcher`

To change the remote config URL, edit `ecosystem.config.cjs` and restart:
- `pm2 restart runalert-watcher`

## Mac installer endpoint (beta)

The server exposes a macOS installer at:
- `GET /install/macos.command`

Set this on the server so the installer can clone the repo:
- `AGENT_REPO_URL=https://github.com/<org>/runAlert`

The installer:
- clones the repo to `~/runAlert` if missing
- installs production dependencies when needed
- installs pm2 if needed
- starts (or restarts) the watcher with `REMOTE_CONFIG_URL` pointing to the server's `/config`
- enables auto-start via `pm2 startup` (may prompt for sudo)

## Beta installer test checklist (local)

1) Set `AGENT_REPO_URL` in `ecosystem.config.cjs` to the repo URL.
2) Restart the watcher with env updates:
   - `pm2 restart runalert-watcher --update-env`
3) Verify the installer response:
   - `curl -I http://localhost:8787/install/macos.command`
4) Smoke-test notifications:
   - `curl -X POST http://localhost:8787/notify/test`

## Current backend layout

- `src/watcher/run_watcher.js` – main loop watching runners + milestones
- `src/paceman/client.js` – Paceman API helpers (get runs, worlds, splits)
- `src/store/dedupe_store.js` – persistent dedupe for sent alerts
- `src/notify/router.js` – routes alerts to actual channels
- `src/notify/desktop_channel.js` – desktop (system) notifications
- `config.json` – streamers, thresholds, quiet hours, per-streamer profiles
- `sent_keys.json` – history of alerts already sent
