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

# --- run from an immutable copy of ourselves ---------------------------------
# Step 1 pulls, and a pull that touches this file corrupts bash's own read of
# it (see the note there). Nothing below is safe until the file being executed
# is one git will not rewrite, so this has to come before every other line.
#
# DEPLOY_SOURCE stays pointed at the repository copy: it is what gets compared
# across the pull, and it is what a re-snapshot re-reads.
DEPLOY_SOURCE=${MIORAIL_DEPLOY_SOURCE:-$(cd "$(dirname "$0")" && pwd)/$(basename "$0")}
export MIORAIL_DEPLOY_SOURCE="$DEPLOY_SOURCE"

file_digest() { sha256sum "$1" | cut -d' ' -f1; }

# Copy the repository script to a private temp file and run that instead,
# forwarding its exit code. `set +e` around the call because a failed deploy
# must reach the cleanup and the explicit exit, not trip `set -e` first.
run_from_snapshot() {
  local snapshot code
  snapshot=$(mktemp /tmp/miorail-deploy.XXXXXXXX.sh)
  cat "$DEPLOY_SOURCE" > "$snapshot"
  set +e
  bash "$snapshot" "$@"
  code=$?
  set -e
  rm -f "$snapshot"
  exit "$code"
}

if [ -z "${MIORAIL_DEPLOY_SNAPSHOT:-}" ]; then
  export MIORAIL_DEPLOY_SNAPSHOT=1
  run_from_snapshot "$@"
fi

REPO=${REPO:-/home/miorail/mioagent}
SERVE_ROOT=${SERVE_ROOT:-/var/www/miorail}
SERVICE_USER=${SERVICE_USER:-miorail}
NODE_BIN=${NODE_BIN:-/home/miorail/.nvm/versions/node/v22.23.1/bin}
SERVICES=(miorail-api miorail-miniapp miorail-b20-discover miorail-b20-measure)
MCP_PUBLIC_URL=${MCP_PUBLIC_URL:-https://miorail.xyz/mcp}
NGINX_SNIPPET_SOURCE="$REPO/ops/nginx/miorail-app.conf"
NGINX_SNIPPET_TARGET=/etc/nginx/snippets/miorail-app.conf
API_UNIT_SOURCE="$REPO/ops/systemd/miorail-api.service"
API_UNIT_TARGET=/etc/systemd/system/miorail-api.service
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
# Filled by step 4. Declared here so `set -u` cannot trip on an empty array.
RWA_TIMERS=()

export PATH="$NODE_BIN:$PATH"
as_service_user() { sudo -u "$SERVICE_USER" env PATH="$PATH" "$@"; }

step() { printf '\n=== %s ===\n' "$1"; }

step "1/7  source"
cd "$REPO"
# `git pull` rewrites this very file while bash is executing it, and bash reads
# a script by byte offset rather than into memory. Every read after the pull
# then lands at the wrong place in the new text. On 2026-08-16 that run
# installed the new commit and dependencies, skipped the systemd unit install
# entirely, and exited after step 7's MiniApp check printing neither
# `Deployed.` nor `FAILED`. A deploy that half-applies without saying so is the
# thing this script exists to prevent, and it could not detect the failure in
# itself.
#
# Comparing digests *after* the pull does not fix it: the very next statement
# bash reads is already corrupt, so the check never runs as written. The file
# being executed has to be one that git cannot touch. `deploy_self_snapshot`
# above put us on an immutable copy; all that is left is to notice that the
# repository copy moved and hand over to a fresh snapshot of it.
digest_before_pull=$(file_digest "$DEPLOY_SOURCE")
# The checkout historically tracked mioku50/mioagent under one of its remote
# names. Never let branch tracking or the on-disk directory name select the
# deployment source implicitly: `origin` is normalized to the canonical
# mioku50/miorail repository before this script is allowed to run.
as_service_user git pull --ff-only origin main
if [ "$(file_digest "$DEPLOY_SOURCE")" != "$digest_before_pull" ]; then
  # A second change can only mean something other than this pull is writing to
  # the working tree. Looping would hide that; stop instead.
  if [ "${MIORAIL_DEPLOY_REEXECED:-}" = 1 ]; then
    echo 'FAILED: deploy.sh changed again after re-exec; refusing to loop'
    exit 1
  fi
  printf '  deploy.sh changed in this pull — continuing with the pulled version\n'
  export MIORAIL_DEPLOY_REEXECED=1
  run_from_snapshot "$@"
fi

step "2/7  dependencies"
# --frozen-lockfile: a deploy that silently resolves a different tree is not a
# deploy of the commit that was reviewed.
#
# CI=true because this script runs detached, with no TTY. When the repository
# pinned `packageManager`, Corepack fetched a pnpm that wanted to recreate
# `node_modules` left by the previous one — and pnpm will not remove a modules
# directory it did not write without confirming, so it aborted with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY and the deploy stopped between
# source and build. A deploy IS a non-interactive context; saying so is not the
# same as forcing anything, and `--frozen-lockfile` still decides the tree.
as_service_user env CI=true pnpm install --frozen-lockfile

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

# Keep the unit in the repository and install it on every deploy so a rebuilt
# Base App cannot silently remain offline behind a healthy-looking build.
#
# It listens on 127.0.0.1:3020 and NO enabled Nginx site proxies to it. The
# comment here used to say Nginx routed "the public MiniApp host" to 3010; that
# was true of an `nginx/sites-available/ritual-familiars` server block which is
# not enabled, so the statement had quietly become false. The Base App surface
# is built and served locally, and reaching it from the internet still needs a
# host and a server block that do not exist yet.
install -m 0644 "$MINIAPP_UNIT_SOURCE" "$MINIAPP_UNIT_TARGET"
# Delete any server-only drop-in for this unit.
#
# One had existed since 2026-08-13 resetting ExecStart and pinning port 3010,
# so the unit file above decided nothing about how the service started — the
# port stayed 3010 through a deploy that installed a unit saying 3020, and the
# override was invisible in `git diff` and in the unit file alike. The working
# invocation it carried now lives in the unit itself. This is the same rule the
# worker drop-ins already follow, applied to the one service that had escaped
# it: what decides how a service starts lives in the commit.
rm -rf "$MINIAPP_UNIT_TARGET.d"
# The API unit lived only on the server until 2026-08-16, so its sandboxing was
# invisible to review and drifted unnoticed: it granted write access to the whole
# checkout. It is installed from the repository now for the same reason as the
# drop-ins below — service state that decides what an intruder can write must
# live in the same commit as the service.
install -m 0644 "$API_UNIT_SOURCE" "$API_UNIT_TARGET"
install -m 0644 "$B20_DISCOVER_UNIT_SOURCE" "$B20_DISCOVER_UNIT_TARGET"
install -m 0644 "$B20_MEASURE_UNIT_SOURCE" "$B20_MEASURE_UNIT_TARGET"
# A 2026-08-13 incident came from an out-of-repo drop-in that silently replaced
# the canonical RPC with an endpoint that returned HTTP 408 / RPC code 30 for
# historical eth_getLogs. Install explicit resets every time: service state
# that can stop the feed must live in the same commit as the worker.
install -d -m 0755 "$(dirname "$B20_DISCOVER_DROPIN_TARGET")" "$(dirname "$B20_MEASURE_DROPIN_TARGET")"
install -m 0644 "$B20_DISCOVER_DROPIN_SOURCE" "$B20_DISCOVER_DROPIN_TARGET"
install -m 0644 "$B20_MEASURE_DROPIN_SOURCE" "$B20_MEASURE_DROPIN_TARGET"

# The RWA vertical's oneshot workers and their timers.
#
# Installed from the repository on every deploy for the same reason the B20
# units are: a schedule that only exists on the host is state nobody can review
# and nobody can restore. Each pair is (service, timer) with the same stem, and
# the loop refuses a pair that is missing half of itself rather than leaving a
# timer pointing at a unit that is not there.
for stem in rwa-official rwa-cash-exit rwa-lookalikes rwa-market-tail rwa-watchlist rwa-ratio rwa-issuer; do
  unit_source="$REPO/ops/systemd/miorail-$stem.service"
  timer_source="$REPO/ops/systemd/miorail-$stem.timer"
  if [ ! -f "$unit_source" ] || [ ! -f "$timer_source" ]; then
    echo "FAILED: miorail-$stem is missing its service or its timer"
    exit 1
  fi
  install -m 0644 "$unit_source" "/etc/systemd/system/miorail-$stem.service"
  install -m 0644 "$timer_source" "/etc/systemd/system/miorail-$stem.timer"
  RWA_TIMERS+=("miorail-$stem.timer")
done

systemctl daemon-reload
systemctl enable miorail-miniapp miorail-b20-discover miorail-b20-measure >/dev/null
# `enable --now` on a timer starts the clock without running the pass, so a
# deploy never fires every worker at once. A NEW timer with Persistent=true
# still fires on its first enable, so a migration a new worker needs must be
# applied BEFORE the deploy, not after it. That ordering has been learned twice
# here — watch_schedule in Phase 8, representation_ratio in Phase 9A.5.
systemctl enable --now "${RWA_TIMERS[@]}" >/dev/null

step "5/7  publish the frontend"
# THE step that was missing. --delete so a removed asset actually disappears
# rather than lingering to be served by a stale index.
rsync -a --delete "$REPO/artifacts/interface/dist/" "$SERVE_ROOT/"
find "$SERVE_ROOT" -type d -exec chmod 755 {} \;
find "$SERVE_ROOT" -type f -exec chmod 644 {} \;

# Pre-compress what nginx would otherwise compress on every request. `gzip -9`
# is slower than nginx can afford per response and cheaper than every response
# put together, because `gzip_static on` then serves the file straight off disk.
# `-k` keeps the original: a client that sent no `Accept-Encoding` still has to
# be served, and `--delete` above means these are rebuilt from scratch anyway.
compressed=0
while IFS= read -r asset; do
  gzip -9 -k -f "$asset"
  chmod 644 "$asset.gz"
  compressed=$((compressed + 1))
done < <(find "$SERVE_ROOT" -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.json' -o -name '*.wasm' -o -name '*.html' \) -size +1k)
raw=$(du -sb "$SERVE_ROOT" 2>/dev/null | cut -f1)
printf '  pre-compressed %s assets (tree now %s KB including .gz)\n' "$compressed" "$((raw / 1024))"

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

MINIAPP_PORT=3020
# Next.js binds about thirteen seconds after systemd starts it, and step 6 does
# not wait. On 2026-08-25 this line ran into a refused connection, and because
# a failed command substitution aborts under `set -e`, the deploy exited with
# curl's own message and printed neither FAILED nor Deployed — the exact
# half-applied-without-saying-so failure this script exists to prevent. The
# service was serving normally seconds later.
#
# `|| miniapp_status=''` is what makes this a loop rather than one attempt: it
# swallows curl's non-zero status so `set -e` cannot abort the assignment. Same
# construction, and the same reasoning, as the MCP readiness wait below.
miniapp_status=''
for attempt in $(seq 1 15); do
  miniapp_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 3 --max-time 10 "http://127.0.0.1:$MINIAPP_PORT/") || miniapp_status=''
  [ "$miniapp_status" = 200 ] && break
  sleep 2
done
printf '  miniapp http://127.0.0.1:%s/  %s\n' "$MINIAPP_PORT" "${miniapp_status:-no answer}"
if [ "$miniapp_status" != 200 ]; then
  # Name the process holding the port. The previous message said only that the
  # service was not serving its build, which is the symptom of a bind failure
  # and of a crashed app alike — and on 2026-08-17 the cause was a NEIGHBOUR
  # process holding the port, which no amount of reading Miorail's logs would
  # have revealed.
  holder=$(ss -lptnH "sport = :$MINIAPP_PORT" 2>/dev/null | head -1)
  [ -n "$holder" ] && echo "  port $MINIAPP_PORT is held by: $holder"
  journalctl -u miorail-miniapp -n 5 --no-pager 2>/dev/null | sed 's/^/  /'
  echo 'FAILED: the Base App service is not serving its production build'
  exit 1
fi

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

# The API binds its port about six seconds after systemd starts it, and step 6
# does not wait. Twice now this step has reported `502` and exited 1 on a deploy
# that had in fact succeeded — the services were up and serving the new bundle
# seconds later. A verification that cries wolf is how a real failure gets
# waved through, so the readiness wait is bounded and explicit rather than the
# check being softened.
mcp_ready=''
for attempt in $(seq 1 20); do
  # `|| mcp_ready=''` is what makes the loop above a loop. curl runs with
  # --fail-with-body, pipefail propagates its non-zero status through the pipe,
  # and under `set -e` a failed command substitution aborts the script — so the
  # FIRST attempt, made while the API is still binding, killed the deploy
  # instead of retrying. It exited 22 with no message, which is why two runs on
  # 2026-08-16 stopped here after printing the MiniApp check and never printed
  # `Deployed.` or `FAILED`. The wait was written to be bounded and explicit;
  # it was neither, because it never ran twice.
  mcp_ready=$(mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"miorail-deploy-smoke","version":"1.0.0"}}}' 2>/dev/null | mcp_data_json) || mcp_ready=''
  [ -n "$mcp_ready" ] && break
  [ "$attempt" = 1 ] && printf '  waiting for the API to bind'
  printf '.'
  sleep 3
done
[ "$mcp_ready" = "" ] || printf '\n'

mcp_initialize="$mcp_ready"
printf '%s' "$mcp_initialize" | jq -e \
  '.result.serverInfo.name == "miorail" and .result.serverInfo.version == "1.1.0" and .result.protocolVersion == "2025-03-26"' \
  >/dev/null || { echo 'FAILED: public MCP initialize response is not Miorail'; exit 1; }
printf '  mcp initialize %-28s %s\n' "$MCP_PUBLIC_URL" 'Miorail 1.1.0'

# Same hazard as the readiness probe, one line down: a failed request here would
# abort under `set -e` with no message at all. The request failing IS a deploy
# failure — it just has to say so, because a script that exits silently is
# indistinguishable from one that was killed.
mcp_tools=$(mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | mcp_data_json) \
  || { echo 'FAILED: the public MCP endpoint did not answer tools/list'; exit 1; }
printf '%s' "$mcp_tools" | jq -e '
  .result.tools
  | map(.name)
  | sort
  == [
    "miorail_b20_market_rails",
    "miorail_compare_b20_tokens",
    "miorail_discover_status",
    "miorail_explain_b20_rejection",
    "miorail_find_b20_projects",
    "miorail_get_b20_opportunity",
    "miorail_list_b20_opportunities",
    "miorail_summarise_b20_universe"
  ]
' >/dev/null || { echo 'FAILED: public MCP tool registry is not the reviewed eight-tool surface'; exit 1; }
printf '  mcp tools/list %-28s %s\n' "$MCP_PUBLIC_URL" '8 read-only tools'

echo
# Counted from the response, not typed in. The literal said "5 tools" for a
# deploy whose own check had just verified six, which is how a summary line
# stops being read at all.
mcp_tool_count=$(printf '%s' "$mcp_tools" | jq -r '.result.tools | length')
echo "Deployed. Served entry: $served_entry · Base App: HTTP $miniapp_status · Miorail MCP: $mcp_tool_count tools"
