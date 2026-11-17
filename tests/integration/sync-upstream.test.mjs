import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Real Git repositories and the real sync and check scripts. Only bin/pnpm is a stub, so no
// install runs. The "upstream" is a local repository passed through UPSTREAM_URL.
const gitEnv = { ...process.env };
for (const key of Object.keys(gitEnv))
  if (key.startsWith("GIT_")) delete gitEnv[key];

const LOCK_CONFLICT = {
  base: "lockfileVersion: base\n",
  fork: "lockfileVersion: fork\n",
  upstream: "lockfileVersion: upstream\n",
};

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-sync-upstream-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env: gitEnv, stdio: "pipe" },
    )
      .toString()
      .trim();
  const upstream = path.join(directory, "upstream");
  const fork = path.join(directory, "fork");
  const pnpmLog = path.join(directory, "pnpm.log");
  mkdirSync(upstream);
  git(upstream, "init", "--initial-branch=main");
  mkdirSync(path.join(upstream, "bin"));
  mkdirSync(path.join(upstream, "scripts"));
  mkdirSync(path.join(upstream, "src"));
  writeFileSync(
    path.join(upstream, "bin/pnpm"),
    `#!/bin/sh\necho "$@" >> "$PNPM_LOG"\nprintf 'lockfileVersion: regenerated\\n' > pnpm-lock.yaml\n`,
  );
  chmodSync(path.join(upstream, "bin/pnpm"), 0o755);
  for (const file of ["sync-upstream.sh", "check-private-names.mjs"])
    copyFileSync(
      new URL(`../../scripts/${file}`, import.meta.url),
      path.join(upstream, "scripts", file),
    );
  chmodSync(path.join(upstream, "scripts/sync-upstream.sh"), 0o755);
  writeFileSync(
    path.join(upstream, "scripts/upstream-edits.txt"),
    "src/listed.txt\nsrc/shared.txt\nsrc/other.txt  (fork-only)\n",
  );
  writeFileSync(path.join(upstream, "pnpm-lock.yaml"), LOCK_CONFLICT.base);
  writeFileSync(path.join(upstream, "src/listed.txt"), "one\n");
  writeFileSync(path.join(upstream, "src/shared.txt"), "base\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "base");
  git(directory, "clone", upstream, fork);

  const commit = (cwd, files, message) => {
    for (const [file, text] of Object.entries(files))
      writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", message);
  };
  const sync = (extraEnv = {}) =>
    spawnSync("bash", ["scripts/sync-upstream.sh"], {
      cwd: fork,
      env: {
        ...gitEnv,
        UPSTREAM_URL: upstream,
        PNPM_LOG: pnpmLog,
        ...extraEnv,
      },
      encoding: "utf8",
    });
  const pnpmCalls = () =>
    existsSync(pnpmLog) ? readFileSync(pnpmLog, "utf8").trim() : "";
  return { directory, upstream, fork, git, commit, sync, pnpmCalls };
}

test("resolves a conflict in pnpm-lock.yaml alone by regenerating it", (t) => {
  const { upstream, fork, git, commit, sync, pnpmCalls } = fixture(t);
  commit(
    upstream,
    { "pnpm-lock.yaml": LOCK_CONFLICT.upstream, "src/listed.txt": "two\n" },
    "upstream change",
  );
  commit(fork, { "pnpm-lock.yaml": LOCK_CONFLICT.fork }, "fork change");

  const result = sync();

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(pnpmCalls(), "install --lockfile-only");
  assert.equal(
    readFileSync(path.join(fork, "pnpm-lock.yaml"), "utf8"),
    "lockfileVersion: regenerated\n",
  );
  assert.equal(
    readFileSync(path.join(fork, "src/listed.txt"), "utf8"),
    "two\n",
  );
  assert.equal(git(fork, "status", "--porcelain"), "");
  assert.equal(
    git(fork, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
    3,
  );
  assert.match(result.stdout, /Nothing was pushed/);
  assert.match(result.stdout, /no private names/);
  // Never pushes: "origin" is the upstream repository here, and its main did not move.
  assert.notEqual(
    git(fork, "rev-parse", "HEAD"),
    git(upstream, "rev-parse", "HEAD"),
  );
});

test("merges with no conflict and leaves the lock file to the merge", (t) => {
  const { upstream, fork, commit, sync, pnpmCalls } = fixture(t);
  commit(upstream, { "src/listed.txt": "two\n" }, "upstream change");
  commit(fork, { "src/shared.txt": "fork\n" }, "fork change");

  const result = sync();

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(pnpmCalls(), "");
  assert.equal(
    readFileSync(path.join(fork, "src/listed.txt"), "utf8"),
    "two\n",
  );
});

test("stops on a conflict outside pnpm-lock.yaml and lists the files", (t) => {
  const { upstream, fork, git, commit, sync, pnpmCalls } = fixture(t);
  commit(
    upstream,
    {
      "pnpm-lock.yaml": LOCK_CONFLICT.upstream,
      "src/shared.txt": "upstream\n",
    },
    "upstream change",
  );
  commit(
    fork,
    { "pnpm-lock.yaml": LOCK_CONFLICT.fork, "src/shared.txt": "fork\n" },
    "fork change",
  );

  const result = sync();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicts outside pnpm-lock\.yaml/);
  assert.match(result.stderr, /^ {2}src\/shared\.txt$/m);
  assert.equal(pnpmCalls(), "");
  // The merge is left in place for a person to finish.
  assert.ok(existsSync(path.join(fork, ".git/MERGE_HEAD")));
  assert.ok(
    git(fork, "diff", "--name-only", "--diff-filter=U").includes(
      "src/shared.txt",
    ),
  );
});

test("fails the check when the merge brings a private name into a listed file", (t) => {
  const { upstream, fork, commit, sync } = fixture(t);
  commit(
    upstream,
    { "src/listed.txt": "const brand = 'SellerCanopy';\n" },
    "upstream change",
  );
  commit(fork, { "src/shared.txt": "fork\n" }, "fork change");

  const result = sync();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/listed\.txt:1: SellerCanopy/);
  // The merge itself committed before the check ran.
  assert.ok(!existsSync(path.join(fork, ".git/MERGE_HEAD")));
});

test("reports an up-to-date branch without merging", (t) => {
  const { sync } = fixture(t);
  const result = sync();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already up to date/);
});

test("refuses a dirty tree, a detached HEAD and a different upstream URL", (t) => {
  const { directory, fork, git, sync } = fixture(t);

  writeFileSync(path.join(fork, "src/listed.txt"), "dirty\n");
  let result = sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncommitted changes/);
  git(fork, "checkout", "--", "src/listed.txt");

  git(fork, "remote", "add", "upstream", path.join(directory, "elsewhere"));
  result = sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different URL/);
  git(fork, "remote", "remove", "upstream");

  git(fork, "checkout", "--detach");
  result = sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HEAD is detached/);
});
