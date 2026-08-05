# README images

Screenshots referenced by the READMEs in this repo.

## Why absolute URLs

Every reference to these files uses the full
`https://raw.githubusercontent.com/ascendaone-com/ai-engineer-tools/main/docs/images/…`
form rather than a relative path. This is not a style choice:

- **`vsce package`** resolves relative README paths against the repo root via
  the `repository` field and can fail or mis-resolve them; the extension README
  is published to the VS Code Marketplace and Open VSX, where a relative path
  points at nothing.
- **npm** renders package READMEs on its own domain, so relative paths 404.

An absolute raw URL renders identically on GitHub, npm, the VS Code
Marketplace, and Open VSX. Keep it that way.

Because the URLs pin `main`, an image only appears once it is merged there —
a branch preview will show a broken image until then. That is expected.

## Expected files

| File | What it shows | Used by |
|---|---|---|
| `vscode-marketplace-search.png` | Extensions pane (⇧⌘X) with "Ascenda" searched, showing the `ascenda-one` publisher and the Install button | root README, extension README |
| `vscode-command-palette.png` | Command Palette (⇧⌘P) with "Ascen" typed, listing the Ascenda commands with **Ascenda: Connect App** highlighted | root README, extension README |
| `vscode-pairing-code.png` | The pairing panel after **Ascenda: Connect App** — QR, six-digit code, expiry, and the privacy statement | root README, extension README |
| `macos-connections-pane.png` | The macOS app's Connections → Ingest telemetry pane, showing the per-tool tabs and the pairing field | root README |

## Capture notes

- Capture at 2× (Retina) and keep the width under ~1400px so the image is
  legible on GitHub without forcing horizontal scroll.
- Use the dark theme — it matches the app's own surfaces and the majority of
  the audience.
- Crop to the relevant pane. The marketplace shot does not need the whole
  window; the palette shot needs only the dropdown.
- **Check before committing that no screenshot contains a real pairing code,
  write token, `toolInstallationId`, file path with a client or employer name,
  or an open file in an unrelated repository.** A pairing secret is one-time
  use and short-lived, but a token or a real path is not, and this repository
  is public.
- **A QR code cannot be redacted by blurring its centre.** QR error correction
  is designed to survive a centre logo (15–30% damage tolerance), so a
  centre-blurred code is generally still decodable — and the pairing QR encodes
  `ascenda://pair?session=…&secret=…`. Only screenshot a code you are willing
  to treat as fully disclosed, and let it expire before committing.
  `vscode-pairing-code.png` is safe on that basis: its session expired minutes
  after capture, and pairing secrets are single-use.
