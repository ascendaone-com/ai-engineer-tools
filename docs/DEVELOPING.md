# Developing on this repo

## Build from source

You don't need this to use the tools. It's here because "verify what you're
running" is a reasonable thing to want from a telemetry tool, and the repo is
Apache-2.0 so you can.

```bash
npm install
npm run build     # shared packages first, then the tools
npm run verify    # the DRY guard rail (scripts/check-dry.sh), a full build, and every test
```

The extension is bundled with esbuild at package time (`npm run package`), so
the shared packages are inlined. Each package's README has its own
development notes.

## Running without a backend

[TESTING.md](../TESTING.md) runs everything with no backend, phone or
sign-in: `./scripts/dev-quickstart.sh` gets events flowing against
[ascenda-dev-server](../ascenda-dev-server/) in about two minutes.

To pair against a dev backend without a phone:

```bash
ascenda-pairing-sim e2e --tool-type cursor_mcp
```

Point a CLI at another backend with `ASCENDA_API_BASE_URL`, or the extension
with the `ascenda.apiBaseUrl` setting. Never commit tokens.

The terminal screenshots above are rendered from the real CLI by
`node scripts/render-cli-shots.mjs`; re-run it when the output changes. See
[docs/images](./images/README.md).
