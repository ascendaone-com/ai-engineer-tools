#!/usr/bin/env bash
# Guard rail: the two IDE extensions must stay thin shells over
# @ascenda/ide-extension-core, and no package may regrow a private copy
# of a module owned by the shared packages.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1. Extension src/ folders may contain only the shell entry point.
for ext in ascenda-vscode-extension-telemetry ascenda-cursor-extension; do
  extra=$(find "$ext/src" -name "*.ts" ! -name "extension.ts" | sort)
  if [ -n "$extra" ]; then
    echo "FAIL: $ext/src must contain only extension.ts (the shell). Found:"
    echo "$extra"
    fail=1
  fi
  if ! grep -q '@ascenda/ide-extension-core' "$ext/src/extension.ts"; then
    echo "FAIL: $ext/src/extension.ts must re-export from @ascenda/ide-extension-core."
    fail=1
  fi
done

# 2. Modules owned by the shared packages must not be re-declared elsewhere.
owned_symbols="function classifyCommand|function isVerificationCommand|function bucketDurationMs|function bucketLinesChanged|function isAfterHours|function persistEventWriteToken|function parseIngestResponse"
dupes=$(grep -rlE "$owned_symbols" \
  ascenda-vscode-extension-telemetry/src \
  ascenda-cursor-extension/src \
  ascenda-claude-code-hooks/src \
  ascenda-pairing-sim/src \
  packages/ide-extension-core/src 2>/dev/null || true)
if [ -n "$dupes" ]; then
  echo "FAIL: shared tool-kit functions re-declared outside packages/tool-kit:"
  echo "$dupes"
  fail=1
fi

# 3. The canonical event catalog must be declared exactly once (tool-contract).
catalog_copies=$(grep -rl 'AscendaTelemetryEventType =' --include="*.ts" \
  packages ascenda-vscode-extension-telemetry/src ascenda-cursor-extension/src \
  ascenda-claude-code-hooks/src ascenda-pairing-sim/src 2>/dev/null \
  | grep -v "packages/tool-contract/src" | grep -v "/out/" || true)
if [ -n "$catalog_copies" ]; then
  echo "FAIL: event catalog re-declared outside packages/tool-contract:"
  echo "$catalog_copies"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "check-dry: FAILED"
  exit 1
fi
echo "check-dry: OK"
