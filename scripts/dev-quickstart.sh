#!/usr/bin/env bash
# Clone -> events flowing in ~2 minutes. No backend, no phone, no DevAuth.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4477}"
BASE="http://localhost:${PORT}"

echo "==> Installing and building the workspace..."
npm install --no-fund --no-audit >/dev/null
npm run build >/dev/null
echo "    done."

echo "==> Starting the local dev server on ${BASE} ..."
node ascenda-dev-server/dist/cli.js --port "${PORT}" &
SERVER_PID=$!
trap 'kill ${SERVER_PID} 2>/dev/null || true' EXIT INT TERM
sleep 1

echo "==> Pairing a demo tool (auto-confirmed, no app needed)..."
CREDS=$(node -e "
const base = '${BASE}';
(async () => {
  const create = await fetch(base + '/v1/tool-pairing-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolInstallationId: 'cli_agent:local-demo', toolType: 'cli_agent', displayName: 'Quickstart Demo' }) }).then(r => r.json());
  const status = await fetch(base + '/v1/tool-pairing-sessions/' + create.pairingSessionId + '/status').then(r => r.json());
  console.log(status.eventWriteToken);
})();
")
export ASCENDA_API_BASE_URL="${BASE}"
export ASCENDA_TOOL_INSTALLATION_ID="cli_agent:local-demo"
export ASCENDA_EVENT_WRITE_TOKEN="${CREDS}"

hook_for_sample() {
  case "$(basename "$1")" in
    sample-user-prompt-*) echo UserPromptSubmit ;;
    sample-pre-compact-*) echo PreCompact ;;
    # Failures are their own hook event in Claude Code's model — piping the
    # failure fixture through PostToolUse would demo it as a success.
    sample-post-tool-use-failure*) echo PostToolUseFailure ;;
    sample-post-tool-use-*) echo PostToolUse ;;
    *) echo "" ;;
  esac
}

echo "==> Sending sample agent events through the real hook CLIs..."
for sample in ascenda-claude-code-hooks/examples/sample-*.json; do
  hook=$(hook_for_sample "${sample}")
  [ -n "${hook}" ] && cat "${sample}" | node ascenda-claude-code-hooks/dist/cli.js "${hook}" || true
done
if [ -d ascenda-codex-hooks/dist ]; then
  for sample in ascenda-codex-hooks/examples/sample-*.json; do
    hook=$(hook_for_sample "${sample}")
    [ -n "${hook}" ] && cat "${sample}" | node ascenda-codex-hooks/dist/cli.js "${hook}" || true
  done
fi

RECEIVED=$(node -e "fetch('${BASE}/_dev/events').then(r=>r.json()).then(d=>console.log(d.events.length))")
echo ""
echo "==> ${RECEIVED} event(s) received by the local server (see lines above)."
echo ""
echo "Next steps — wire your real agents at this server (see TESTING.md):"
echo "  export ASCENDA_API_BASE_URL=${BASE}"
echo "  export ASCENDA_TOOL_INSTALLATION_ID=${ASCENDA_TOOL_INSTALLATION_ID}"
echo "  export ASCENDA_EVENT_WRITE_TOKEN=${ASCENDA_EVENT_WRITE_TOKEN}"
echo ""
echo "  VS Code / Cursor:  set  ascenda.apiBaseUrl = ${BASE}   then run 'Ascenda: Connect App' (auto-pairs)"
echo "  Claude Code:       register hooks per ascenda-claude-code-hooks/README.md, reuse the exports above"
echo ""
echo "Server keeps running — watch events arrive live. Ctrl-C to stop."
wait ${SERVER_PID}
