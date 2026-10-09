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
| `macos-connections-pane.png` | The macOS app's Connections → Ingest telemetry pane. **Out of date:** captured 5 Aug 2026, before the pane was rebuilt, with an autofill icon over the pairing field. No longer referenced; retake before using | (none) |
| `cli-setup-no-pair.png` | `setup --no-pair` finishing with "Ready." **Generated**, see below | root README, Claude Code README |
| `cli-doctor-ready.png` | `doctor` on a fresh install, with the verdict line. **Generated** | root README |
| `cli-doctor-problem.png` | `doctor` naming a problem (hooks not registered) and its fix. **Generated** | root README |

## Generated terminal shots

The `cli-*.png` images are rendered from the real CLI, not captured by hand:

```bash
npm run build -w @ascenda-one/claude-code-hooks
node scripts/render-cli-shots.mjs            # add --html to keep the page it drew
```

Each one runs the built CLI against a throwaway home folder, with colour
forced on, no live listener and no screen saver, then draws the output in a
terminal frame and captures it with headless Chrome (`CHROME=` for another
binary). Paths under your own home are written as `~`, so a username never
reaches the image. Re-run it whenever `setup` or `doctor` output changes, and
commit the PNGs with that change.

## Wanted

Captured by hand from the real apps; not in the repo yet.

| File | What it should show | For |
|---|---|---|
| `claude-code-hooks-user.png` | Claude Code's `/hooks` list with the Ascenda hooks under **User** | root README, Check it works |
| `codex-hooks-trust.png` | Codex's `/hooks` at the point of trusting the Ascenda hooks | root README, Codex steps |
| `cli-doctor-saver.png` | `doctor` with the screen saver on screen: "listening, pid N, on screen" and "Round trip OK" | root README, Check it works. Needs the real saver, so it can't be generated |
| `macos-connections-pane.png` | A retake of the current Connections → Ingest telemetry pane, ideally showing the upgrade nudge | root README, Upgrading |
| `waterline-waiting.png` | The screen saver with "1 agent is waiting on you." under the clock | root README, opening |

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
