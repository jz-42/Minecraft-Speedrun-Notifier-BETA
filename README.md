# runAlert — Minecraft Speedrun Notifier (dev notes)

Minimal notes to get the repo running for development and testing.

Prerequisites
- Node.js >= 18 (uses native `fetch` in `src/paceman/client.js`)

Quick run (single iteration, debug, override quiet hours):

```bash
node src/watcher/run_watcher.js --debug=1 --once --no-quiet
```

Common flags
- `--debug=1` : enable debug logging (default true)
- `--once` : run one iteration per streamer and exit (useful for testing)
- `--dry-run` : don't actually send notifications; useful when testing
- `--force` : ignore thresholds and force notification logic
- `--no-quiet` : ignore `quietHours` in `config.json`

Important files
- `config.json` : list of `streamers`, `defaultMilestones`, and per-streamer `profiles`.
- `src/watcher/run_watcher.js` : main poller + watcher loop.
- `src/paceman/client.js` : paceman.gg API helpers.
- `src/notify` : notification channels (desktop by default).
- `sent_keys.json` : dedupe storage of already-sent alert keys (ignored by git).

Env & secrets
- Put any tokens (Discord, Twilio) in a `.env` file at repo root. See existing `.env` for examples.

Resetting dedupe
- To allow re-sending alerts for the same runs while testing, delete or clear `sent_keys.json`.

Next suggested step: add a small CLI helper flag to list configured streamers (`--list-streamers`) for quick checks.

---

# Public Beta (User-Facing)

Beta disclaimer
- This is a **beta**. Expect bugs and occasional notification delays.
- Settings are saved **per browser** (token‑based).

Quick usage
1. Open the dashboard link.
2. Add streamers and set milestone thresholds.
3. Enable **Browser alerts** (tab open) for immediate testing.
4. Install the **Mac agent** to receive background alerts when the tab is closed.

Privacy (high level)
- No account required.
- Only saves the configuration you set (streamers + thresholds).
- No PII required.

Troubleshooting
- **No browser banners, but sound plays:** macOS may be delivering to Notification Center only. Try System Settings → Notifications → your browser → set to “Alerts”.
- **Browser alerts not firing:** ensure you clicked “Enable browser alerts (tab open)” and permissions are granted.
- **Mac installer blocked:** Right-click installer → Open, or allow in System Settings → Privacy & Security.
- **Live dot seems wrong:** it tracks Twitch live status (not Paceman). Verify Twitch handle and refresh.

If you want, add a custom domain (shorter “via …” line on notifications) and update the public link accordingly.
