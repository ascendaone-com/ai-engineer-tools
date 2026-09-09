# Codex hook execution resolution

Codex CLI 0.153.4 can execute the existing user-scope command hooks. No hook
schema change, alternative distribution, daemon restart, or bypass flag is
required by the verified configuration.

## Cause and evidence

The adapter allowed a globally exported `ASCENDA_TOOL_INSTALLATION_ID` qualified
for another tool type to override `tools.codex` in the credentials file. That
made the expected Codex journal an unreliable execution check: delivery state
is keyed by the resolved identity, not the adapter name.

The investigation used these independent observations:

- The installed binary's generated app-server protocol exposes `hooks/list`.
  A fresh stdio server reported the registered commands as user-scope, enabled,
  and trusted, with matching persisted hashes and no configuration errors.
- Existing local event-log records carried `metadata.host: "codex"` under an
  identity of the wrong tool type. Turn-timing files also showed the adapter
  had reached `UserPromptSubmit` processing.
- After installing the corrected bundle, an ordinary interactive CLI launch
  with no command-line flags completed a short prompt. Its rollout identified
  the source as `cli` and recorded completion. Event-log records for that same
  session showed accepted session-start and prompt events with the identity
  from `tools.codex` and `metadata.host: "codex"`. The expected `cli_agent`
  journal reported `lastOutcome: "accepted"`.

The historical no-output hangs were not reproduced or diagnosed. Persisted
hook trust already existed when this investigation began, contrary to the
handoff's earlier configuration snapshot. The evidence establishes current
execution and the identity-selection defect; it does not establish the cause
of every historical failed experiment.

## Changes

`packages/tool-kit/src/hookAdapter.ts` now ignores environment and credential
ids qualified for a different tool type, then tries the remaining identity
sources. Matching qualified overrides and unqualified overrides retain their
precedence. A missing matching identity still fails through the existing
unresolved-identity journal path. This rule also protects the other adapters
using the shared resolver.

`src/setup.ts` keeps the working registration shape and tells users to review
and trust the commands with `/hooks`, then verify actual delivery. Setup does
not grant itself trust. Codex records trust against each hook definition;
changing a definition can require review again. See the
[official hook reference](https://learn.chatgpt.com/docs/hooks).

`tests/setup.test.mjs` checks every example handler's full shape against setup
output after normalizing the command launcher. Shared identity tests cover
foreign environment overrides, token selection, invalid credential fallback,
missing matching identities, and unqualified overrides.

## Validation and machine state

The shared build, Codex bundle build, full tool-kit test suite, and Codex test
suite passed. The example remains unchanged because its shape was already
correct.

The previous installed hook bundle was backed up before installing the fix.
The interactive check temporarily wrote workspace trust and onboarding state;
`config.toml` was restored, and both it and `hooks.json` were verified against
their original file hashes. Pairings and tokens were preserved. No daemon was
restarted and no existing Ascenda state was deleted.

## Verification rule

Registration, runtime trust, handler invocation, and accepted delivery are
separate checks. Use `/hooks` for runtime trust. For delivery, correlate the
session id, `metadata.host`, and resolved installation id in the event log,
then check that installation's journal. Do not infer process non-execution
from the absence of one expected journal. Hooks mapping to no event also make
no delivery attempt.
