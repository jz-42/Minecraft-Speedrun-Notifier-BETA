#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BETA_DIR="$(cd "$ROOT_DIR/.." && pwd)/beta"

if [ ! -d "$BETA_DIR/.git" ]; then
  echo "Missing beta repo at $BETA_DIR (expected a git repo)."
  echo "Create the public repo clone here before publishing."
  exit 1
fi

rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dashboard/node_modules" \
  --exclude ".env" \
  --exclude "sent_keys.json" \
  --exclude ".DS_Store" \
  --exclude "runalert-beta" \
  "$ROOT_DIR"/ "$BETA_DIR"/

echo "Beta repo synced at $BETA_DIR"
