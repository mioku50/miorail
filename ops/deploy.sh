#!/usr/bin/env bash
#
# Deploy Miorail to ritual-vps. Run as root on the host.
#
# This exists because the step that publishes the frontend lived nowhere but
# in someone's memory. On 2026-08-08 the API was redeployed twice and the
# browser kept serving a bundle thirteen minutes old: `pnpm build` writes to
# artifacts/interface/dist, nginx reads /var/www/miorail, and nothing joined
# the two. Two fixes were verified as shipped that had never reached a user.
#
# So: one script, in the repo, that does every step in order and refuses to
# claim success it has not checked.
#
# It is deliberately not clever. No parallelism, no partial modes — a deploy
# that is fast and half-applied is the thing this is here to prevent.

set -euo pipefail

REPO=${REPO:-/home/miorail/mioagent}
SERVE_ROOT=${SERVE_ROOT:-/var/www/miorail}
SERVICE_USER=${SERVICE_USER:-miorail}
NODE_BIN=${NODE_BIN:-/home/miorail/.nvm/versions/node/v22.23.1/bin}
SERVICES=(miorail-api miorail-b20-discover miorail-b20-measure)

export PATH="$NODE_BIN:$PATH"
as_service_user() { sudo -u "$SERVICE_USER" env PATH="$PATH" "$@"; }

step() { printf '\n=== %s ===\n' "$1"; }

step "1/6  source"
cd "$REPO"
as_service_user git pull --ff-only

step "2/6  dependencies"
# --frozen-lockfile: a deploy that silently resolves a different tree is not a
# deploy of the commit that was reviewed.
as_service_user pnpm install --frozen-lockfile

step "3/6  build"
# `pnpm -r build` runs each package's own build. For the interface that is
# `tsc -b && vite build`, and the `-b` matters: it type-checks against emitted
# .d.ts files, so it catches errors `tsc --noEmit` resolves away from source.
# One such error reached main because --noEmit was treated as equivalent.
as_service_user pnpm -r build

step "4/6  publish the frontend"
# THE step that was missing. --delete so a removed asset actually disappears
# rather than lingering to be served by a stale index.
rsync -a --delete "$REPO/artifacts/interface/dist/" "$SERVE_ROOT/"
find "$SERVE_ROOT" -type d -exec chmod 755 {} \;
find "$SERVE_ROOT" -type f -exec chmod 644 {} \;

step "5/6  restart"
systemctl restart "${SERVICES[@]}"
sleep 5
for service in "${SERVICES[@]}"; do
  state=$(systemctl is-active "$service" || true)
  printf '  %-26s %s\n' "$service" "$state"
  [ "$state" = active ] || { echo "FAILED: $service is $state"; exit 1; }
done

step "6/6  verify what a browser will actually get"
# Comparing the served entry bundle against the one just built is the only
# check that would have caught the stale-copy failure. Everything above can
# succeed while this is wrong.
built_entry=$(grep -o 'assets/[A-Za-z0-9_-]*\.js' "$REPO/artifacts/interface/dist/index.html" | head -1)
served_entry=$(grep -o 'assets/[A-Za-z0-9_-]*\.js' "$SERVE_ROOT/index.html" | head -1)
printf '  built  %s\n  served %s\n' "$built_entry" "$served_entry"
[ "$built_entry" = "$served_entry" ] || { echo 'FAILED: the served bundle is not the built one'; exit 1; }

echo
echo "Deployed. Served entry: $served_entry"
