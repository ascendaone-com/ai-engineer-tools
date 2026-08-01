#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Workspace install + shared packages must exist before this package can build.
npm --prefix .. install
npm --prefix .. run build:shared
npm run build
npm link
echo "Installed ascenda-claude-hook globally via npm link."
echo "Set ASCENDA_API_BASE_URL, ASCENDA_TOOL_INSTALLATION_ID and ASCENDA_EVENT_WRITE_TOKEN before using hooks."
