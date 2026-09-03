const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  deriveWorkContext,
  forgeProjectHash,
  parseForgeFullName,
  forgeFullNameFromConfig,
  readForgeFullName,
  recordForgeProjectAlias,
  readWorkContextRegistry
} = require("../out/index.js");

let root;
let saltFile;
let registryFile;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-forge-"));
  saltFile = path.join(root, "salt");
  registryFile = path.join(root, "work-contexts.json");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ── the digest is frozen ──────────────────────────────────────────────────
//
// A forge collector has already put these strings on stored rows and cannot
// re-key them. `referenceHash` is a verbatim copy of the implementation that
// shipped in ascenda-github-collector/src/mapForgeEvent.ts before it moved
// here; it is duplicated ON PURPOSE, as the frozen witness the shared
// function is checked against.

function referenceHash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const FULL_NAMES = [
  "acme/payments-service",
  "ascendaone-com/ai-engineer-tools",
  "octocat/Hello-World",
  "a/b",
  "org-with-dashes/repo.with.dots",
  "OWNER/REPO",
  "owner/repo"
];

test("the shared digest matches the implementation the collector shipped", () => {
  for (const fullName of FULL_NAMES) {
    assert.equal(forgeProjectHash(fullName), referenceHash(fullName), fullName);
  }
});

test("the digest is pinned to literal values, so a refactor cannot drift it", () => {
  // Recomputed from the pre-move collector implementation on 3 Sep 2026.
  assert.equal(forgeProjectHash("acme/payments-service"), "918128f5");
  assert.equal(forgeProjectHash("ascendaone-com/ai-engineer-tools"), "ab6b59c3");
  assert.equal(forgeProjectHash("octocat/Hello-World"), "1e17c458");
  assert.equal(forgeProjectHash("a/b"), "3a8e75c1");
});

test("the digest is 8 lowercase hex characters, padded", () => {
  for (const fullName of FULL_NAMES) {
    assert.match(forgeProjectHash(fullName), /^[0-9a-f]{8}$/);
  }
});

test("casing changes the digest, which is why both variants get registered", () => {
  assert.notEqual(forgeProjectHash("OWNER/REPO"), forgeProjectHash("owner/repo"));
});

// ── remote URL parsing ────────────────────────────────────────────────────

test("every remote URL form git writes yields the same owner/repo", () => {
  const forms = [
    "https://github.com/acme/payments-service.git",
    "https://github.com/acme/payments-service",
    "https://github.com/acme/payments-service/",
    "http://github.com/acme/payments-service.git",
    "https://token@github.com/acme/payments-service.git",
    "https://user:pass@github.com/acme/payments-service.git",
    "https://www.github.com/acme/payments-service.git",
    "https://GitHub.com/acme/payments-service.git",
    "git@github.com:acme/payments-service.git",
    "git@github.com:acme/payments-service",
    "ssh://git@github.com/acme/payments-service.git",
    "ssh://git@github.com:22/acme/payments-service.git",
    "git://github.com/acme/payments-service.git",
    "  https://github.com/acme/payments-service.git  "
  ];
  for (const url of forms) {
    assert.equal(parseForgeFullName(url), "acme/payments-service", url);
  }
});

test("a remote whose casing differs is carried through verbatim", () => {
  assert.equal(parseForgeFullName("git@github.com:AcmeCo/Payments-Service.git"), "AcmeCo/Payments-Service");
});

test("a non-github remote is not a forge identity this module can name", () => {
  const unnameable = [
    "git@gitlab.com:acme/payments-service.git",
    "https://bitbucket.org/acme/payments-service.git",
    "https://github.example.com/acme/payments-service.git",
    "https://ghe.internal/acme/payments-service.git",
    "/Users/someone/src/payments-service",
    "../sibling-checkout",
    "C:\\src\\payments-service",
    "https://github.com/acme",
    "https://github.com/",
    "",
    null,
    undefined
  ];
  for (const url of unnameable) {
    assert.equal(parseForgeFullName(url), null, String(url));
  }
});

// ── reading the checkout's own config ─────────────────────────────────────

const CONFIG_HEAD = '[core]\n\trepositoryformatversion = 0\n';

function remoteSection(name, url) {
  return `[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`;
}

test("origin wins over every other remote", () => {
  const config =
    CONFIG_HEAD +
    remoteSection("upstream", "git@github.com:upstream-org/payments-service.git") +
    remoteSection("origin", "git@github.com:acme/payments-service.git") +
    remoteSection("mirror", "git@github.com:mirror-org/payments-service.git");
  assert.equal(forgeFullNameFromConfig(config), "acme/payments-service");
});

test("upstream is the fallback when origin is not a github remote", () => {
  const config =
    CONFIG_HEAD +
    remoteSection("origin", "git@gitlab.com:acme/payments-service.git") +
    remoteSection("upstream", "https://github.com/upstream-org/payments-service.git");
  assert.equal(forgeFullNameFromConfig(config), "upstream-org/payments-service");
});

test("with neither origin nor upstream, the first github remote in file order wins", () => {
  const config =
    CONFIG_HEAD +
    remoteSection("fork", "https://github.com/fork-org/payments-service.git") +
    remoteSection("other", "https://github.com/other-org/payments-service.git");
  assert.equal(forgeFullNameFromConfig(config), "fork-org/payments-service");
});

test("a config with no remotes, or none on github, names nothing", () => {
  assert.equal(forgeFullNameFromConfig(CONFIG_HEAD), null);
  assert.equal(
    forgeFullNameFromConfig(CONFIG_HEAD + remoteSection("origin", "/srv/git/payments.git")),
    null
  );
});

test("branch sections carrying a remote key are not mistaken for remotes", () => {
  const config =
    CONFIG_HEAD +
    remoteSection("origin", "git@github.com:acme/payments-service.git") +
    '[branch "main"]\n\tremote = origin\n\turl = not-a-remote-url\n';
  assert.equal(forgeFullNameFromConfig(config), "acme/payments-service");
});

test("a missing or unreadable config is null, not a throw", () => {
  assert.equal(readForgeFullName(path.join(root, "no-such-repo")), null);
  assert.equal(readForgeFullName(null), null);
  assert.equal(readForgeFullName(undefined), null);
});

// ── registration ──────────────────────────────────────────────────────────

function makeCheckout(name, remoteUrl) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  if (remoteUrl) {
    fs.writeFileSync(path.join(repo, ".git", "config"), CONFIG_HEAD + remoteSection("origin", remoteUrl));
  }
  return repo;
}

test("the forge digest lands as an alias carrying the project's own label", () => {
  const repo = makeCheckout("payments-service", "git@github.com:acme/payments-service.git");
  const context = deriveWorkContext(repo, saltFile);

  assert.equal(recordForgeProjectAlias(context, { registryFilePath: registryFile }), true);

  const entry = readWorkContextRegistry(registryFile).contexts[forgeProjectHash("acme/payments-service")];
  assert.equal(entry.kind, "alias");
  // The label is what ties an alias to its canonical entry, so it must be the
  // repository basename the project entry carries — never `owner/repo`.
  assert.equal(entry.label, "payments-service");
  assert.deepEqual(entry.paths, [repo]);
});

test("a mixed-case remote registers both the literal and the lowercased digest", () => {
  const repo = makeCheckout("Payments-Api", "git@github.com:AcmeCo/Payments-Api.git");
  const context = deriveWorkContext(repo, saltFile);

  assert.equal(recordForgeProjectAlias(context, { registryFilePath: registryFile }), true);

  const registry = readWorkContextRegistry(registryFile);
  assert.equal(registry.contexts[forgeProjectHash("AcmeCo/Payments-Api")].kind, "alias");
  assert.equal(registry.contexts[forgeProjectHash("acmeco/payments-api")].kind, "alias");
});

test("an already-lowercase remote registers exactly one digest", () => {
  const repo = makeCheckout("billing", "https://github.com/acme/billing.git");
  const context = deriveWorkContext(repo, saltFile);
  const before = Object.keys(readWorkContextRegistry(registryFile).contexts).length;

  recordForgeProjectAlias(context, { registryFilePath: registryFile });

  const after = Object.keys(readWorkContextRegistry(registryFile).contexts).length;
  assert.equal(after - before, 1);
});

test("a worktree registers the parent repository's forge identity", () => {
  const repo = makeCheckout("ledger", "git@github.com:acme/ledger.git");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt-one"), { recursive: true });
  const worktree = path.join(root, "ledger-wt-one");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt-one")}\n`);

  const context = deriveWorkContext(worktree, saltFile);
  assert.equal(recordForgeProjectAlias(context, { registryFilePath: registryFile }), true);
  assert.equal(
    readWorkContextRegistry(registryFile).contexts[forgeProjectHash("acme/ledger")].label,
    "ledger"
  );
});

test("registering the same checkout twice on the same day writes once", () => {
  const repo = makeCheckout("invoices", "git@github.com:acme/invoices.git");
  const context = deriveWorkContext(repo, saltFile);
  recordForgeProjectAlias(context, { registryFilePath: registryFile });
  assert.equal(recordForgeProjectAlias(context, { registryFilePath: registryFile }), false);
});

test("every degraded input returns false instead of throwing into the hook path", () => {
  assert.equal(recordForgeProjectAlias(null, { registryFilePath: registryFile }), false);
  assert.equal(recordForgeProjectAlias(undefined, { registryFilePath: registryFile }), false);

  // A checkout with no remote at all.
  const bare = makeCheckout("no-remote", null);
  assert.equal(
    recordForgeProjectAlias(deriveWorkContext(bare, saltFile), { registryFilePath: registryFile }),
    false
  );

  // A checkout whose remote lives on another forge.
  const elsewhere = makeCheckout("elsewhere", "git@gitlab.com:acme/elsewhere.git");
  assert.equal(
    recordForgeProjectAlias(deriveWorkContext(elsewhere, saltFile), { registryFilePath: registryFile }),
    false
  );

  // A path that is not a repository at all — no project root to read from.
  const loose = path.join(root, "loose-folder");
  fs.mkdirSync(loose, { recursive: true });
  assert.equal(
    recordForgeProjectAlias(deriveWorkContext(loose, saltFile), { registryFilePath: registryFile }),
    false
  );
});
