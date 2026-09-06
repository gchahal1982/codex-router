#!/usr/bin/env bash
# Rebase this custom fork onto upstream Codex Router, then rebuild the
# packaged Control Center and menu-bar tray. Does not run Playwright.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/duolahypercho/codex-router.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
CUSTOM_BRANCH="${CUSTOM_BRANCH:-custom/v0.5.1}"

cd "$ROOT"

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
git checkout "$CUSTOM_BRANCH"
git rebase "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"

if [[ -d "$ROOT/apps/control-center" ]]; then
  (
    cd "$ROOT/apps/control-center"
    npm run build
  )
fi

if [[ -d "$ROOT/apps/macos/CodexRouterTray" ]]; then
  swift build -c release --package-path "$ROOT/apps/macos/CodexRouterTray"
fi

echo "Rebase complete on $CUSTOM_BRANCH. Install with scripts/install-custom-fork.sh"
