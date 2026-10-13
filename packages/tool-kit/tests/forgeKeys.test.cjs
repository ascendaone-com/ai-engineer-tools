const { test } = require("node:test");
// The saved setting and the machine salt live under ~/.ascenda. Keep the real
// ones out of these results.
process.env.ASCENDA_HOME = require("node:fs").mkdtempSync(
  require("node:path").join(require("node:os").tmpdir(), "ascenda-test-home-")
);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { forgeBranchKey, forgeProjectHash, forgeRepoKey, deriveForgeKeysForCwd, repoKeysEnabled, writeRepoKeysSetting, readMachineCredentials, writeTopLevelCredentials } = require("../out");

// The forge collector computes these from a webhook payload and the hooks from
// a checkout. They only join if both sides agree to the byte.

test("the repository key is the frozen digest of the lowercased name", () => {
  assert.equal(forgeRepoKey("acme/payments"), forgeProjectHash("acme/payments"));
  assert.equal(forgeRepoKey("Acme/Payments"), forgeRepoKey("acme/payments"));
  assert.match(forgeRepoKey("acme/payments"), /^[0-9a-f]{8}$/);
});

// A reference FNV-1a 64 written a second way, so the production loop is checked
// against something that doesn't share its code.
function reference64(text) {
  let h = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = (1n << 64n) - 1n;
  for (const byte of Buffer.from(text, "utf8")) h = ((h ^ BigInt(byte)) * prime) & mask;
  return h.toString(16).padStart(16, "0");
}

test("the branch key is 64-bit FNV-1a of 'owner/repo', a newline and the branch", () => {
  assert.equal(forgeBranchKey("acme/payments", "feat/x"), reference64("acme/payments\nfeat/x"));
  assert.equal(forgeBranchKey("Acme/Payments", "feat/x"), forgeBranchKey("acme/payments", "feat/x"));
  assert.match(forgeBranchKey("acme/payments", "feat/x"), /^[0-9a-f]{16}$/);
});

test("the branch name keeps its case, and the repository is part of the key", () => {
  assert.notEqual(forgeBranchKey("acme/payments", "Feat"), forgeBranchKey("acme/payments", "feat"));
  assert.notEqual(forgeBranchKey("acme/payments", "fix"), forgeBranchKey("acme/billing", "fix"));
});

// Literal values, so a change to the recipe fails here, not in the join.
test("literal digests stay put", () => {
  assert.equal(forgeBranchKey("acme/payments", "main"), reference64("acme/payments\nmain"));
  assert.equal(forgeBranchKey("acme/payments", "main").length, 16);
});

function checkout({ remote, branch, defaultBranch }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ascenda-forge-keys-"));
  fs.mkdirSync(path.join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  if (remote) fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  if (defaultBranch) fs.writeFileSync(path.join(root, ".git", "refs", "remotes", "origin", "HEAD"), `ref: refs/remotes/origin/${defaultBranch}\n`);
  return root;
}

test("a feature branch gets both keys", () => {
  const root = checkout({ remote: "git@github.com:Acme/Payments.git", branch: "feat/x", defaultBranch: "main" });
  assert.deepEqual(deriveForgeKeysForCwd(root), {
    repoKey: forgeRepoKey("acme/payments"),
    branchKey: forgeBranchKey("acme/payments", "feat/x")
  });
});

test("the default branch gets the repository key only", () => {
  const root = checkout({ remote: "https://github.com/acme/payments.git", branch: "main", defaultBranch: "main" });
  assert.deepEqual(deriveForgeKeysForCwd(root), { repoKey: forgeRepoKey("acme/payments") });
});

test("a branch from a subdirectory is the same branch", () => {
  const root = checkout({ remote: "https://github.com/acme/payments.git", branch: "feat/x" });
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  assert.equal(deriveForgeKeysForCwd(path.join(root, "src", "deep")).branchKey, forgeBranchKey("acme/payments", "feat/x"));
});

test("no keys without a github.com remote, a checkout or a branch name to give", () => {
  assert.deepEqual(deriveForgeKeysForCwd(checkout({ remote: "https://gitlab.com/acme/payments.git", branch: "feat/x" })), {});
  assert.deepEqual(deriveForgeKeysForCwd(checkout({ branch: "feat/x" })), {});
  assert.deepEqual(deriveForgeKeysForCwd(os.tmpdir()), {});
  assert.deepEqual(deriveForgeKeysForCwd(undefined), {});
  const detached = checkout({ remote: "https://github.com/acme/payments.git", branch: "x" });
  fs.writeFileSync(path.join(detached, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.deepEqual(deriveForgeKeysForCwd(detached), { repoKey: forgeRepoKey("acme/payments") });
});

test("the environment and the saved setting both turn the keys off", () => {
  const root = checkout({ remote: "https://github.com/acme/payments.git", branch: "feat/x" });
  assert.equal(repoKeysEnabled(), true);
  process.env.ASCENDA_REPO_KEYS = "off";
  try {
    assert.deepEqual(deriveForgeKeysForCwd(root), {});
    process.env.ASCENDA_REPO_KEYS = "on";
    assert.equal(repoKeysEnabled(), true);
  } finally {
    delete process.env.ASCENDA_REPO_KEYS;
  }
  writeRepoKeysSetting(false);
  try {
    assert.equal(repoKeysEnabled(), false);
    assert.deepEqual(deriveForgeKeysForCwd(root), {});
    // A re-pair rewrites the pairing fields and must not turn the keys back on.
    writeTopLevelCredentials({ apiBaseUrl: "http://127.0.0.1:1", toolInstallationId: "claude_code:x", pairedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(readMachineCredentials().repoKeys, false);
  } finally {
    writeRepoKeysSetting(true);
  }
  assert.equal(repoKeysEnabled(), true);
  assert.equal("repoKeys" in (readMachineCredentials() ?? {}), false);
});
