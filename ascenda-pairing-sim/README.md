# Ascenda Pairing Sim

Console app that **simulates the Ascenda mobile app** for pairing tests.

Tool packages only implement the tool side (create session, poll, ingest, tool-scoped renew). Confirmation requires an authenticated user bearer — this CLI is that missing half for local/dev testing without a phone.

## Development auth

Against a **Development** backend (`ASPNETCORE_ENVIRONMENT=Development`):

| Host | Notes |
| --- | --- |
| `http://localhost:5002` | Local BE |
| `https://app-asc-dev-api-aue.azurewebsites.net` | Deployed Dev (same DevAuth behaviour) |

- SmartAuth routes any **non-JWT** bearer to **DevAuth**
- DevAuth maps known bearer strings to a GUID `sub` (required by confirm)
- These are **not** real JWTs and must **never** be committed

| Purpose | Env var | Role |
| --- | --- | --- |
| User (confirm / list / revoke) | `ASCENDA_USER_TOKEN` | Patient (fixed DevAuth GUID) |
| Admin (metrics endpoint) | `ASCENDA_ADMIN_TOKEN` | Admin (fixed DevAuth GUID) |

**Setup (local only):**

```bash
cp local.devauth.env.example local.devauth.env
# Paste DevAuth bearer values from the BE team handoff into local.devauth.env
# Set ASCENDA_API_BASE_URL to localhost:5002 or the Azure Dev host
# local.devauth.env is gitignored — never commit it
```

The CLI auto-loads `local.devauth.env` when present (shell env vars win if already set).

For non-Development / shared environments, use a real app/Kinde user JWT instead.

### Backend prerequisites (learned on Azure Dev)

DevAuth alone is not enough. The DevAuth user GUID must also exist in the environment database:

1. **User row** for the Patient DevAuth GUID in `Users`
2. **Active consent leases** for that user (at least `AiDataProcessing` / consent types used by `ide_telemetry`)

Without (1), `confirm-device-code` can return **500** during pairing completion.  
Without (2), pairing may succeed but ingest returns **`403 consent_missing_or_expired`**.

If the App Service is unhealthy you will see Azure **503 Application Error** HTML (not a JSON API error) — wait for the host to recover, then retry.

## Installation (terminal / CLI)

No IDE install — this is a Node console app used alongside the extensions.

### Prerequisites

- Node.js **20+** and npm
- Development backend with DevAuth (or a real user JWT for non-Dev)
- Gitignored `local.devauth.env` (see [Development auth](#development-auth))

### Install

```bash
cd ascenda-pairing-sim
npm install
npm run build
npm link   # optional: puts ascenda-pairing-sim on PATH
```

Without `npm link`:

```bash
node dist/cli.js --help
node dist/cli.js e2e --tool-type cursor_mcp
```

### Configure

```bash
cp local.devauth.env.example local.devauth.env
# Fill DevAuth tokens from BE handoff (never commit)
# ASCENDA_API_BASE_URL=https://app-asc-dev-api-aue.azurewebsites.net
```

The CLI loads `local.devauth.env` automatically.

## Typical tool-team workflow

### A. Pair a running extension

1. Point the extension at Dev (`ascenda.apiBaseUrl` = `http://localhost:5002` or `https://app-asc-dev-api-aue.azurewebsites.net`)
2. **Ascenda: Connect App** — note the 6-digit code
3. Confirm as the app:

```bash
ascenda-pairing-sim confirm-device-code 413902
```

4. Extension poll completes → stores `eventWriteToken`
5. **Ascenda: Send Test Signal** / editor activity to verify ingest

### B. Full e2e without an IDE

```bash
ascenda-pairing-sim e2e --tool-type cursor_mcp
```

Prints `toolInstallationId` + `eventWriteToken` and writes the token under `~/.ascenda/tokens/` for Claude hooks.

Verified on Azure Dev (happy path): create session → `confirm-device-code` → status poll → ingest → tool-scoped renew → ingest → `list` → `revoke` → ingest returns `401`.

### C. Claude hooks after e2e

```bash
export ASCENDA_TOOL_INSTALLATION_ID="cursor_mcp:..."
export ASCENDA_EVENT_WRITE_TOKEN="..."
# or rely on ~/.ascenda/tokens/<id> written by e2e / renew
```

### D. Revoke / re-pair

```bash
ascenda-pairing-sim list
ascenda-pairing-sim revoke vscode_extension:3b53f1dc-...
```

After revoke, tool-scoped ingest and renew must fail with **401** (`Invalid token or revoked tool connection`). Re-pair with a new session to continue.

## Commands

```text
confirm-device-code <code>              # preferred app confirm path
confirm-code <code>
confirm-secret <pairingSessionId> <secret>
list
revoke <toolInstallationId>
renew-user <toolInstallationId>        # app-side renew (user bearer)
status <pairingSessionId>              # anonymous poll
e2e [--tool-type ...] [--name ...]     # create + confirm + print token
```

Tool-scoped renew (used by extensions / hooks, not this CLI’s default path) is:

```http
POST /v1/tool-events/renew-token
Authorization: Bearer <eventWriteToken>
```

## What this is not

- Not a substitute for mobile UX / QR scanning QA
- Not a production client
- Does not mint identity (you supply `ASCENDA_USER_TOKEN` via local DevAuth file or real JWT)

## Contract reference

See [TOOL_PAIRING_API_REFERENCE.md](../api-docs/TOOL_PAIRING_API_REFERENCE.md).
