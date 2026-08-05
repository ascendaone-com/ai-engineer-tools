#!/usr/bin/env bash
#
# One command from a clone to telemetry flowing out of your own Claude Code
# session — no backend, no phone, no DevAuth tokens.
#
#   ./scripts/setup-local.sh          build, start the dev server, wire hooks
#   ./scripts/setup-local.sh --stop   stop the dev server
#
# All the real work lives in `ascenda-claude-hook setup`, the same code path
# `npx @ascenda-one/claude-code-hooks setup` runs. This script only adds the
# two things a clone can do that npx cannot: build the workspace, and run a
# local ingest server to point at.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4477}"
BASE="http://localhost:${PORT}"
STATE_DIR=".ascenda"
PID_FILE="${STATE_DIR}/dev-server.pid"
LOG_FILE="${STATE_DIR}/dev-server.log"
HOOK_CLI="ascenda-claude-code-hooks/dist/cli.js"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

server_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

stop_server() {
  if server_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "dev server stopped."
  else
    echo "dev server is not running."
  fi
}

if [ "${1:-}" = "--stop" ]; then
  stop_server
  exit 0
fi

say "1. Build"
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 20+ and re-run."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node $(node -v) found; this needs 20+."
npm install --no-fund --no-audit --silent
npm run build --silent
ok "node $(node -v), workspace built"

say "2. Local ingest server"
mkdir -p "$STATE_DIR"
if server_running; then
  ok "already running on ${BASE} (pid $(cat "$PID_FILE"))"
else
  # Detached on purpose: the point is to close this terminal, open Claude Code,
  # and still have somewhere for events to land.
  nohup node ascenda-dev-server/dist/cli.js --port "$PORT" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in $(seq 1 20); do
    curl -sf "${BASE}/_dev/events" >/dev/null 2>&1 && break
    sleep 0.25
  done
  server_running || die "dev server failed to start — see ${LOG_FILE}"
  ok "${BASE} (pid $(cat "$PID_FILE")), logging to ${LOG_FILE}"
fi

say "3. Pair and register hooks"
node "$HOOK_CLI" setup --local "$PORT" --project-dir "$PWD"

say "4. Verify"
before=$(curl -s "${BASE}/_dev/events" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).events.length))")
node "$HOOK_CLI" PostToolUse < ascenda-claude-code-hooks/examples/sample-post-tool-use-edit.json
after=$(curl -s "${BASE}/_dev/events" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).events.length))")
if [ "$after" -gt "$before" ]; then
  ok "event ingested (${before} → ${after})"
else
  die "no event arrived — check ${LOG_FILE}"
fi

cat <<DONE

Restart Claude Code in this repo, then work normally.

  watch events     tail -f ${LOG_FILE}
  everything so far curl -s ${BASE}/_dev/events
  check wiring     node ${HOOK_CLI} status
  stop the server  ./scripts/setup-local.sh --stop
DONE
