#!/usr/bin/env bash
set -euo pipefail
npm install
npm run build
npm link
echo "Installed ascenda-claude-hook globally via npm link."
echo "Set ASCENDA_API_BASE_URL, ASCENDA_TOOL_INSTALLATION_ID and ASCENDA_EVENT_WRITE_TOKEN before using hooks."
