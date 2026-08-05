#!/usr/bin/env bash
#
# Replay a representative hook payload for every supported agent through its
# real adapter CLI, so each mapper is exercised end to end without installing
# five agents.
#
#   ./scripts/replay-agent-hooks.sh              every agent
#   ./scripts/replay-agent-hooks.sh cursor       one agent
#   ./scripts/replay-agent-hooks.sh --log FILE   write the JSONL somewhere specific
#
# Delivery column shows what happened: `accepted` when the agent is paired and
# a server is listening, `not_sent` when it is not paired, `other` when the
# backend is unreachable. All three are useful; none are failures of this script.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

LOG=""
if [ "${1:-}" = "--log" ]; then LOG="$2"; shift 2; fi
ONLY="${1:-}"
if [ -z "$LOG" ]; then LOG="$(mktemp -t ascenda-replay).jsonl"; fi
: > "$LOG"

fire() { # agent, hookName, json
  local agent="$1" hook="$2" payload="$3"
  local cli="$REPO/ascenda-$agent-hooks/dist/cli.js"
  [ "$agent" = "claude" ] && cli="$REPO/ascenda-claude-code-hooks/dist/cli.js"
  [ -f "$cli" ] || { echo "  !! not built: $cli"; return; }
  printf '%s' "$payload" | env ASCENDA_EVENT_LOG_FILE="$LOG" node "$cli" "$hook" >/dev/null 2>&1
}

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

if want claude; then
  echo "claude-code..."
  fire claude UserPromptSubmit '{"prompt":"that is wrong, try again"}'
  fire claude PreToolUse       '{"tool_name":"Bash"}'
  fire claude PostToolUse      '{"tool_name":"Bash","durationMs":42000,"tool_input":{"command":"npm test"},"result":{"exitCode":0}}'
  fire claude PostToolUse      '{"tool_name":"Bash","durationMs":8200,"tool_input":{"command":"npm run typecheck"},"result":{"exitCode":1}}'
  fire claude PostToolUse      '{"tool_name":"Edit","durationMs":1200,"result":{"exitCode":0}}'
  fire claude PreCompact       '{"trigger":"auto"}'
fi

if want codex; then
  echo "codex..."
  fire codex SessionStart     '{"source":"startup","session_id":"cx-1"}'
  fire codex UserPromptSubmit '{"prompt":"that is wrong, try again","session_id":"cx-1"}'
  fire codex PreToolUse       '{"tool_name":"local_shell","session_id":"cx-1"}'
  fire codex PostToolUse      '{"tool_name":"local_shell","tool_input":{"command":"pytest -q"},"result":{"exitCode":0},"session_id":"cx-1"}'
  fire codex PostToolUse      '{"tool_name":"local_shell","tool_input":{"command":"cargo build"},"result":{"exitCode":1},"session_id":"cx-1"}'
  fire codex PostToolUse      '{"tool_name":"apply_patch","result":{"exitCode":0},"session_id":"cx-1"}'
  fire codex PreCompact       '{"trigger":"auto","session_id":"cx-1"}'
fi

if want cursor; then
  echo "cursor..."
  fire cursor sessionStart       '{"conversation_id":"cu-1","session_id":"cu-1","composer_mode":"agent"}'
  fire cursor beforeSubmitPrompt '{"conversation_id":"cu-1","prompt":"that is wrong, try again"}'
  fire cursor preToolUse         '{"conversation_id":"cu-1","tool_name":"Shell","tool_input":{"command":"npm test"}}'
  fire cursor postToolUse        '{"conversation_id":"cu-1","tool_name":"Shell","tool_input":{"command":"npm test"},"tool_output":"{\"exitCode\":0}","duration":42000}'
  fire cursor postToolUseFailure '{"conversation_id":"cu-1","tool_name":"Shell","tool_input":{"command":"npm run build"},"error_message":"exit 1","failure_type":"error","duration":9000,"is_interrupt":false}'
  fire cursor postToolUseFailure '{"conversation_id":"cu-1","tool_name":"Shell","tool_input":{"command":"npm run dev"},"failure_type":"error","duration":500,"is_interrupt":true}'
  fire cursor postToolUse        '{"conversation_id":"cu-1","tool_name":"Edit","tool_output":"{\"exitCode\":0}","duration":1200}'
  fire cursor preCompact         '{"conversation_id":"cu-1","trigger":"auto","context_usage_percent":85}'
  fire cursor sessionEnd         '{"conversation_id":"cu-1"}'
fi

if want windsurf; then
  echo "windsurf..."
  fire windsurf pre_user_prompt   '{"agent_action_name":"pre_user_prompt","trajectory_id":"ws-1","tool_info":{"user_prompt":"that is wrong, try again"}}'
  fire windsurf pre_run_command   '{"agent_action_name":"pre_run_command","trajectory_id":"ws-1","tool_info":{"command_line":"npm test","cwd":"/p"}}'
  fire windsurf post_run_command  '{"agent_action_name":"post_run_command","trajectory_id":"ws-1","tool_info":{"command_line":"npm test","cwd":"/p"}}'
  fire windsurf post_write_code   '{"agent_action_name":"post_write_code","trajectory_id":"ws-1","tool_info":{"file_path":"/p/a.ts"}}'
  fire windsurf post_read_code    '{"agent_action_name":"post_read_code","trajectory_id":"ws-1","tool_info":{"file_path":"/p/a.ts"}}'
  fire windsurf post_mcp_tool_use '{"agent_action_name":"post_mcp_tool_use","trajectory_id":"ws-1","tool_info":{"mcp_tool_name":"search","mcp_result":{"isError":true}}}'
  fire windsurf post_setup_worktree '{"agent_action_name":"post_setup_worktree","trajectory_id":"ws-1","tool_info":{}}'
fi

if want gemini; then
  echo "gemini..."
  fire gemini SessionStart '{"hook_event_name":"SessionStart","session_id":"gm-1"}'
  fire gemini BeforeAgent  '{"hook_event_name":"BeforeAgent","session_id":"gm-1","prompt":"that is wrong, try again"}'
  fire gemini BeforeTool   '{"hook_event_name":"BeforeTool","session_id":"gm-1","tool_name":"run_shell_command"}'
  fire gemini AfterTool    '{"hook_event_name":"AfterTool","session_id":"gm-1","tool_name":"run_shell_command","tool_input":{"command":"pytest -q"},"tool_response":{"exitCode":0}}'
  fire gemini AfterTool    '{"hook_event_name":"AfterTool","session_id":"gm-1","tool_name":"run_shell_command","tool_input":{"command":"npm run lint"},"tool_response":{"exitCode":1}}'
  fire gemini AfterTool    '{"hook_event_name":"AfterTool","session_id":"gm-1","tool_name":"write_file","tool_response":{"exitCode":0}}'
  fire gemini PreCompress  '{"hook_event_name":"PreCompress","session_id":"gm-1"}'
  fire gemini AfterModel   '{"hook_event_name":"AfterModel","session_id":"gm-1","llm_response":{}}'
fi

echo
if command -v jq >/dev/null 2>&1; then
  jq -r '[.delivery, .payload.metadata.host // "-", .payload.eventType, (.payload.metadata.commandClass // "-"), (.payload.metadata.outcome // "-")] | @tsv' "$LOG" \
    | awk 'BEGIN{printf "%-10s %-11s %-30s %-10s %s\n","DELIVERY","HOST","EVENT","CMDCLASS","OUTCOME"}{printf "%-10s %-11s %-30s %-10s %s\n",$1,$2,$3,$4,$5}'
else
  cat "$LOG"
fi
echo
echo "$(wc -l < "$LOG" | tr -d ' ') events -> $LOG"
