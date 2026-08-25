# AGENTS.md

## This repository is public

`ascendaone-com/ai-engineer-tools` is a public GitHub repository under
Apache-2.0. Everything committed here — source, comments, docs, test
fixtures, commit messages, PR descriptions — is world-readable the moment it
is pushed, and stays readable afterwards: a force-push does not remove a diff
already visible on a pull request, and orphaned commits remain reachable by
SHA. Write every line as if a competitor and a customer will both read it,
because the cost of getting this wrong is not recoverable by editing later.

The published npm bundles strip comments, so prose in this repo reaches
people through GitHub rather than through releases. That is not a reason to
relax — GitHub is where people actually read it.

### Never commit

- **Internal repository, branch, or service names.** No `asc-core-be`, no
  `asc-ascenda-app-workspace`, no `claude/<branch>` names. Say "the backend",
  "the app workspace", "the backend repo".
- **Internal file paths, class names, or doc titles from other repos.** Not
  `Services/ToolTelemetryCatalog.cs`, not `PERSONALISED_INTERVENTION_ENGINE_SPEC.md`,
  not internal test-class names or decision-register IDs. Describe the thing
  by what it does: "the backend's telemetry catalog", "the backend's ingest
  tests".
- **Absolute paths from a developer machine.** No `/Users/<name>/…`. Use a
  placeholder or a repo-relative path.
- **Measurements taken from a real person's machine.** Session counts, prompt
  counts, after-hours tallies, token totals, store censuses, install dates,
  monthly adoption curves. These are simultaneously someone's personal
  telemetry and the empirical research that makes this tooling worth
  something. State the invariant and the threshold; do not publish the
  dataset that validates it.
- **A working description of a control that is not yet enforced.** Saying
  "the deployed backend does not check X, so Y currently rides in under Z" is
  an instruction sheet. Record that enforcement is server-side and still
  rolling out, and that shipping is gated on it. Keep the guard, drop the
  bypass.

### Comments: what to keep

The test is **what a maintainer needs versus what a competitor needs.**

Keep: what the code does, the invariant it must preserve, why a rule exists,
what breaks if you change it, which fixtures pin it. A reverse-engineered
store's field names and paths belong in the header comment — the code
implements them anyway, so omitting them hides nothing from an outsider and
costs the next maintainer real time.

Cut: the measured proof. "Most user-role lines are tool results, not prompts;
conflating them inflates prompt metrics by roughly an order of magnitude" is a
maintainer's warning. Adding "108,528 lines reduce to 8,272 on a real store"
hands a competitor a free validation set for their own classifier.

### Before pushing

Grep your diff for internal names, absolute home paths, and precise counts
that could only have come from a real machine:

```bash
git diff --cached | grep -nE "asc-core-be|asc-ascenda|/Users/|reference machine|verified live"
```

A hit is not automatically wrong — it is a prompt to ask whether that detail
is load-bearing for a maintainer, or just expensive.
