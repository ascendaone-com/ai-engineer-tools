#!/usr/bin/env bash
# Guard rail: the two IDE extensions must stay thin shells over
# @ascenda-one/ide-extension-core, and no package may regrow a private copy
# of a module owned by the shared packages.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# Consumer source trees that must not re-declare shared code. tool-kit and
# tool-contract own their modules and are excluded from ownership checks only.
consumer_dirs=(
  ascenda-vscode-extension-telemetry/src
  ascenda-cursor-extension/src
  ascenda-cursor-extension/mcp-adapter
  ascenda-claude-code-hooks/src
  ascenda-codex-hooks/src
  ascenda-pairing-sim/src
  ascenda-dev-server/src
  packages/ide-extension-core/src
)
existing_dirs=()
for d in "${consumer_dirs[@]}"; do
  [ -d "$d" ] && existing_dirs+=("$d")
done

# 1. Extension src/ folders may contain only the shell entry point.
for ext in ascenda-vscode-extension-telemetry ascenda-cursor-extension; do
  extra=$(find "$ext/src" -name "*.ts" ! -name "extension.ts" | sort)
  if [ -n "$extra" ]; then
    echo "FAIL: $ext/src must contain only extension.ts (the shell). Found:"
    echo "$extra"
    fail=1
  fi
  if ! grep -q '@ascenda-one/ide-extension-core' "$ext/src/extension.ts"; then
    echo "FAIL: $ext/src/extension.ts must re-export from @ascenda-one/ide-extension-core."
    fail=1
  fi
done

# 2. Functions owned by tool-kit must not be re-declared elsewhere.
#    Matches declaration forms: `function name`, `const/let/var name =`,
#    and class-method definitions `name(...): Type {` at line start.
owned_names="classifyCommand|isVerificationCommand|bucketDurationMs|bucketLinesChanged|isAfterHours|persistEventWriteToken|readTokenFile|defaultTokenFilePath|parseIngestResponse|readOrCreateMachineSalt|hashWithMachineSalt|machineSaltFilePath"
decl_re="^[[:space:]]*(export[[:space:]]+)?((async[[:space:]]+)?function[[:space:]]+(${owned_names})\\b|(const|let|var)[[:space:]]+(${owned_names})[[:space:]]*=|(private[[:space:]]+|public[[:space:]]+|protected[[:space:]]+)?(${owned_names})[[:space:]]*\\([^)]*\\)[[:space:]]*:[^;]*\\{)"
dupes=$(grep -rlE "$decl_re" --include="*.ts" "${existing_dirs[@]}" packages/tool-contract/src 2>/dev/null || true)
if [ -n "$dupes" ]; then
  echo "FAIL: tool-kit-owned functions re-declared outside packages/tool-kit:"
  echo "$dupes"
  fail=1
fi

# 3. The canonical event catalog must live only in tool-contract. Two nets:
#    the type name, and a sentinel event string that no tool ever emits
#    (supervis_meeting_load), which only appears where the full catalog is
#    enumerated - catching const-array or renamed-type copies.
catalog_copies=$(grep -rl 'AscendaTelemetryEventType' --include="*.ts" \
  "${existing_dirs[@]}" packages/tool-kit/src 2>/dev/null \
  | xargs -I{} grep -lE 'AscendaTelemetryEventType[[:space:]]*=' {} 2>/dev/null || true)
sentinel_copies=$(grep -rl 'supervis_meeting_load' --include="*.ts" \
  "${existing_dirs[@]}" packages/tool-kit/src 2>/dev/null || true)
combined=$(printf '%s\n%s\n' "$catalog_copies" "$sentinel_copies" | sort -u | sed '/^$/d')
if [ -n "$combined" ]; then
  echo "FAIL: event catalog (or a copy of it) declared outside packages/tool-contract:"
  echo "$combined"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "check-dry: FAILED"
  exit 1
fi
echo "check-dry: OK"
