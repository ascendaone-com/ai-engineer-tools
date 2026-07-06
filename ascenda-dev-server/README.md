# Ascenda Dev Server

Local, zero-dependency mock of the Ascenda `/v1` pairing and ingest contract
([TOOL_PAIRING_API_REFERENCE.md](../api-docs/TOOL_PAIRING_API_REFERENCE.md)).
Lets anyone test every tool in this repo **without a backend, a phone, or
DevAuth tokens** — and see, live, exactly what each tool emits.

```bash
node dist/cli.js              # http://localhost:4477, auto-confirms pairings
node dist/cli.js --manual     # exercise the real confirm flow (pairing-sim / curl)
```

Implements: pairing sessions + confirm + status (token on first paired poll
only), single/batch ingest with category classification from
`@ascenda/tool-contract`'s catalog map, tool-scoped renew with rotation,
connected-tools list/revoke (post-revoke ingest 401), consent gating.

Dev-only extras under `/_dev`: `GET /_dev/events` (everything received),
`POST /_dev/reset`, `POST /_dev/consent {"active":false}` to simulate a
lapsed consent lease.

Faithful enough that the integration suite drives the **real
`@ascenda/tool-kit` client** through pair → ingest → renew → revoke → 401
against it. Not the product backend: no scoring, baselines, or aggregation.

See [TESTING.md](../TESTING.md) for the two-minute quickstart.
