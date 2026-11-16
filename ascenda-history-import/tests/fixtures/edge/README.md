# Edge fixtures

One small transcript per edge case, each under 40 lines. Everything in them
is invented: placeholder text, `/Users/example/...` paths, ids like
`00000000-0000-4000-8000-0000000000a1`.

`tests/edgeFixtures.test.mjs` runs the extractors over each one and checks
the figures in that store's README. A case the extractor gets wrong today is
a `todo` that links the plan fixing it. Delete the `todo` when the fix lands.

- [claude_code/](claude_code/README.md)
- [codex/](codex/README.md)

The seeded generator in `tests/support/corpus.mjs` writes the same shapes at
volume. These files are the ones to read first when a figure moves.
