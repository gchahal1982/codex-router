#!/usr/bin/env bash
# Copy this checkout into the live Codex Router install tree and refresh the
# packaged Control Center + tray. Does not run Playwright or a full app build.
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${CODEX_ROUTER_INSTALL:-$HOME/.local/share/codex-router-v0.5.1}"
APP="${CODEX_ROUTER_APP:-$HOME/Applications/Codex Router.app}"
NESTED="$APP/Contents/Resources/Control Center.app"
CC_OUT="${TMPDIR:-/tmp}/codex-router-cc-out"

if [[ "$SOURCE" == "$DEST" ]]; then
  echo "Source and install tree are the same: $DEST"
else
  mkdir -p "$DEST"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'apps/control-center/node_modules' \
    --exclude 'apps/control-center/dist' \
    --exclude 'apps/macos/CodexRouterTray/.build' \
    --exclude '.DS_Store' \
    "$SOURCE/" "$DEST/"
fi

cd "$DEST/apps/control-center"
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder \
  --mac dir --arm64 --publish never \
  --config.directories.output="$CC_OUT"

osascript -e 'quit app "Codex Router"' >/dev/null 2>&1 || true
sleep 1

if [[ -d "$NESTED" && -d "$CC_OUT/mac-arm64/Control Center.app" ]]; then
  ditto "$CC_OUT/mac-arm64/Control Center.app" "$NESTED"
  printf '%s\n' "$DEST" > "$NESTED/Contents/Resources/router-root"
fi

swift build -c release --package-path "$DEST/apps/macos/CodexRouterTray"
TRAY_BIN="$DEST/apps/macos/CodexRouterTray/.build/release/CodexRouterTray"
if [[ -x "$TRAY_BIN" && -d "$APP/Contents/MacOS" ]]; then
  ditto "$TRAY_BIN" "$APP/Contents/MacOS/CodexRouterTray"
  if [[ -d "$DEST/apps/macos/CodexRouterTray/.build/release/CodexRouterTray.bundle" ]]; then
    ditto "$DEST/apps/macos/CodexRouterTray/.build/release/CodexRouterTray.bundle" \
      "$APP/Contents/Resources/CodexRouterTray.bundle" || true
  fi
fi

if [[ -d "$NESTED" ]]; then
  codesign --force --deep --sign - "$NESTED"
fi
if [[ -d "$APP" ]]; then
  codesign --force --sign - "$APP"
fi

if [[ -x "$DEST/bin/control" ]]; then
  "$DEST/bin/control" service restart || true
fi

open "$APP"
echo "Installed custom fork from $SOURCE into $DEST"
