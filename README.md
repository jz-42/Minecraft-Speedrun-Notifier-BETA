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

Notes
- I (the maintainer) follow a small-diff workflow: make one focused change, run the single-iteration test above, then commit if green. I keep `VISION.md`, `WORKSTYLE.md`, and `TECH_NOTES.md` in mind when making changes.

Next suggested step: add a small CLI helper flag to list configured streamers (`--list-streamers`) for quick checks.
