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
SERVICES=(miorail-api miorail-miniapp miorail-b20-discover miorail-b20-measure)
MCP_PUBLIC_URL=${MCP_PUBLIC_URL:-https://miorail.xyz/mcp}
NGINX_SNIPPET_SOURCE="$REPO/ops/nginx/miorail-app.conf"
NGINX_SNIPPET_TARGET=/etc/nginx/snippets/miorail-app.conf
MINIAPP_UNIT_SOURCE="$REPO/ops/systemd/miorail-miniapp.service"
MINIAPP_UNIT_TARGET=/etc/systemd/system/miorail-miniapp.service
B20_DISCOVER_UNIT_SOURCE="$REPO/ops/systemd/miorail-b20-discover.service"
B20_DISCOVER_UNIT_TARGET=/etc/systemd/system/miorail-b20-discover.service
B20_MEASURE_UNIT_SOURCE="$REPO/ops/systemd/miorail-b20-measure.service"
B20_MEASURE_UNIT_TARGET=/etc/systemd/system/miorail-b20-measure.service
B20_DISCOVER_DROPIN_SOURCE="$REPO/ops/systemd/miorail-b20-discover-runtime.conf"
B20_DISCOVER_DROPIN_TARGET=/etc/systemd/system/miorail-b20-discover.service.d/rpc.conf
B20_MEASURE_DROPIN_SOURCE="$REPO/ops/systemd/miorail-b20-measure-runtime.conf"
B20_MEASURE_DROPIN_TARGET=/etc/systemd/system/miorail-b20-measure.service.d/rpc.conf

export PATH="$NODE_BIN:$PATH"
as_service_user() { sudo -u "$SERVICE_USER" env PATH="$PATH" "$@"; }

step() { printf '\n=== %s ===\n' "$1"; }

step "1/7  source"
cd "$REPO"
as_service_user git pull --ff-only

step "2/7  dependencies"
# --frozen-lockfile: a deploy that silently resolves a different tree is not a
# deploy of the commit that was reviewed.
as_service_user pnpm install --frozen-lockfile

step "3/7  build"
# `pnpm -r build` runs each package's own build. For the interface that is
# `tsc -b && vite build`, and the `-b` matters: it type-checks against emitted
# .d.ts files, so it catches errors `tsc --noEmit` resolves away from source.
# One such error reached main because --noEmit was treated as equivalent.
# Vite and Next inline PUBLIC variables at build time. The service environment
# reaches the API at runtime, but it cannot retroactively add ERC-8021 to a
# browser bundle, so resolve the one canonical public Builder Code explicitly.
# Never `source` the whole .env into a build: it also carries server secrets.
read_public_env_value() {
  local wanted=$1 line key value
  [ -f "$REPO/.env" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    key=${key//[[:space:]]/}
    [ "$key" = "$wanted" ] || continue
    value=${line#*=}
    value=${value%%#*}
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [ "${value:0:1}" = '"' ] && [ "${value: -1}" = '"' ]; then value=${value:1:${#value}-2}; fi
    if [ "${value:0:1}" = "'" ] && [ "${value: -1}" = "'" ]; then value=${value:1:${#value}-2}; fi
    printf '%s' "$value"
    return 0
  done < "$REPO/.env"
}
public_builder_code=$(read_public_env_value BASE_BUILDER_CODE)
legacy_builder_code=$(read_public_env_value BUILDER_CODE)
if [ -n "$public_builder_code" ] && [ -n "$legacy_builder_code" ] && [ "$public_builder_code" != "$legacy_builder_code" ]; then
  echo 'FAILED: BASE_BUILDER_CODE and deprecated BUILDER_CODE disagree; refusing an ambiguously attributed build'
  exit 1
fi
public_builder_code=${public_builder_code:-$legacy_builder_code}
case "$public_builder_code" in
  ''|todo|TODO|changeme|CHANGE_ME|replace_me|REPLACE_ME)
    echo 'FAILED: BASE_BUILDER_CODE is missing or still a placeholder'
    exit 1
    ;;
esac
if ! [[ "$public_builder_code" =~ ^[a-z0-9_]{1,32}$ ]]; then
  echo 'FAILED: a valid BASE_BUILDER_CODE is required to build attributed production wallet calls'
  exit 1
fi
as_service_user env \
  VITE_BASE_BUILDER_CODE="$public_builder_code" \
  NEXT_PUBLIC_BASE_BUILDER_CODE="$public_builder_code" \
  pnpm -r build

step "4/7  install Nginx route, Base App and B20 services"
# The public MCP endpoint is mounted at the API root rather than under /api.
# Keep its reverse-proxy route in the repository: otherwise Nginx serves the
# SPA for GET /mcp and rejects the MCP client's POST with its own HTTP 405.
nginx_backup=$(mktemp)
nginx_target_existed=false
if [ -f "$NGINX_SNIPPET_TARGET" ]; then
  cp -p "$NGINX_SNIPPET_TARGET" "$nginx_backup"
  nginx_target_existed=true
fi
install -m 0644 "$NGINX_SNIPPET_SOURCE" "$NGINX_SNIPPET_TARGET"
if ! nginx -t; then
  if [ "$nginx_target_existed" = true ]; then
    install -m 0644 "$nginx_backup" "$NGINX_SNIPPET_TARGET"
  else
    rm -f "$NGINX_SNIPPET_TARGET"
  fi
  rm -f "$nginx_backup"
  nginx -t
  echo 'FAILED: repository Nginx configuration is invalid; restored the previous snippet'
  exit 1
fi
rm -f "$nginx_backup"
systemctl reload nginx

# Nginx has always routed the public MiniApp host to port 3010. Keep the unit
# in the repository and install it on every deploy so a rebuilt Base App cannot
# silently remain offline behind a healthy-looking build.
install -m 0644 "$MINIAPP_UNIT_SOURCE" "$MINIAPP_UNIT_TARGET"
install -m 0644 "$B20_DISCOVER_UNIT_SOURCE" "$B20_DISCOVER_UNIT_TARGET"
install -m 0644 "$B20_MEASURE_UNIT_SOURCE" "$B20_MEASURE_UNIT_TARGET"
# A 2026-08-13 incident came from an out-of-repo drop-in that silently replaced
# the canonical RPC with an endpoint that returned HTTP 408 / RPC code 30 for
# historical eth_getLogs. Install explicit resets every time: service state
# that can stop the feed must live in the same commit as the worker.
install -d -m 0755 "$(dirname "$B20_DISCOVER_DROPIN_TARGET")" "$(dirname "$B20_MEASURE_DROPIN_TARGET")"
install -m 0644 "$B20_DISCOVER_DROPIN_SOURCE" "$B20_DISCOVER_DROPIN_TARGET"
install -m 0644 "$B20_MEASURE_DROPIN_SOURCE" "$B20_MEASURE_DROPIN_TARGET"
systemctl daemon-reload
systemctl enable miorail-miniapp miorail-b20-discover miorail-b20-measure >/dev/null

step "5/7  publish the frontend"
# THE step that was missing. --delete so a removed asset actually disappears
# rather than lingering to be served by a stale index.
rsync -a --delete "$REPO/artifacts/interface/dist/" "$SERVE_ROOT/"
find "$SERVE_ROOT" -type d -exec chmod 755 {} \;
find "$SERVE_ROOT" -type f -exec chmod 644 {} \;

step "6/7  restart"
systemctl restart "${SERVICES[@]}"
sleep 5
for service in "${SERVICES[@]}"; do
  state=$(systemctl is-active "$service" || true)
  printf '  %-26s %s\n' "$service" "$state"
  [ "$state" = active ] || { echo "FAILED: $service is $state"; exit 1; }
done

step "7/7  verify what browsers will actually get"
# Comparing the served entry bundle against the one just built is the only
# check that would have caught the stale-copy failure. Everything above can
# succeed while this is wrong.
built_entry=$(grep -o 'assets/[A-Za-z0-9_-]*\.js' "$REPO/artifacts/interface/dist/index.html" | head -1)
served_entry=$(grep -o 'assets/[A-Za-z0-9_-]*\.js' "$SERVE_ROOT/index.html" | head -1)
printf '  built  %s\n  served %s\n' "$built_entry" "$served_entry"
[ "$built_entry" = "$served_entry" ] || { echo 'FAILED: the served bundle is not the built one'; exit 1; }

miniapp_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3010/)
printf '  miniapp http://127.0.0.1:3010/  %s\n' "$miniapp_status"
[ "$miniapp_status" = 200 ] || { echo 'FAILED: the Base App service is not serving its production build'; exit 1; }

MCP_ACCEPT='application/json, text/event-stream'
mcp_post() {
  curl --silent --show-error --fail-with-body \
    --connect-timeout 10 \
    --max-time 30 \
    --header 'Content-Type: application/json' \
    --header "Accept: $MCP_ACCEPT" \
    --data-binary "$1" \
    "$MCP_PUBLIC_URL"
}
mcp_data_json() {
  sed -n 's/^data: //p' | tail -1
}

mcp_initialize=$(mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"miorail-deploy-smoke","version":"1.0.0"}}}' | mcp_data_json)
printf '%s' "$mcp_initialize" | jq -e \
  '.result.serverInfo.name == "miorail" and .result.serverInfo.version == "1.1.0" and .result.protocolVersion == "2025-03-26"' \
  >/dev/null || { echo 'FAILED: public MCP initialize response is not Miorail'; exit 1; }
printf '  mcp initialize %-28s %s\n' "$MCP_PUBLIC_URL" 'Miorail 1.1.0'

mcp_tools=$(mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | mcp_data_json)
printf '%s' "$mcp_tools" | jq -e '
  .result.tools
  | map(.name)
  | sort
  == [
    "miorail_discover_status",
    "miorail_explain_b20_rejection",
    "miorail_get_b20_market_leaders",
    "miorail_get_b20_opportunity",
    "miorail_list_b20_opportunities"
  ]
' >/dev/null || { echo 'FAILED: public MCP tool registry is not the reviewed five-tool surface'; exit 1; }
printf '  mcp tools/list %-28s %s\n' "$MCP_PUBLIC_URL" '5 read-only tools'

echo
echo "Deployed. Served entry: $served_entry · Base App: HTTP $miniapp_status · Miorail MCP: 5 tools"
