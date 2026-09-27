import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

const runner = fileURLToPath(new URL("../foundry-runner.mjs", import.meta.url));
const scratchEntries = () =>
  new Set(readdirSync("/tmp").filter((name) => name.startsWith("foundry-worker-")));

// The worker can intentionally run a test script even though only the host
// verifier's separate execution counts. Do not let that create unapproved
// candidate files (a real Foundry dogfood run exposed this failure mode).
test("model-driven project commands put temporary files outside the candidate and clean them", () => {
  const project = mkdtempSync(join(tmpdir(), "foundry-scratch-fixture-"));
  const sentinel = mkdtempSync(join(tmpdir(), "foundry-scratch-denied-"));
  try {
    writeFileSync(join(sentinel, "private.txt"), "DENIED_HOST_DATA\n");
    const before = scratchEntries();
    const command =
      `printf '%s\\n' "$TMPDIR" "$NODE_COMPILE_CACHE" "$npm_config_cache" "$XDG_CACHE_HOME" "$(stat -c %a "$TMPDIR")"; ` +
      `mkdir -p "$NODE_COMPILE_CACHE" "$npm_config_cache" "$XDG_CACHE_HOME"; ` +
      `printf CACHE > "$TMPDIR/probe"; printf EDIT > allowed.txt; ` +
      `if cat ${JSON.stringify(join(sentinel, "private.txt"))} >/dev/null 2>&1; then exit 42; fi`;
    const result = spawnSync(
      process.execPath,
      [runner, "--workspace", resolve(project), "--command", command],
      { cwd: project, encoding: "utf8", timeout: 18_000, maxBuffer: 100_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const [scratch, nodeCache, npmCache, xdgCache, scratchMode] = result.stdout.trim().split("\n");
    assert.match(scratch, /^\/tmp\/foundry-worker-[A-Za-z0-9]+$/);
    assert.notEqual(scratch, project);
    assert.equal(nodeCache, join(scratch, "node-compile-cache"));
    assert.equal(npmCache, join(scratch, "npm-cache"));
    assert.equal(xdgCache, join(scratch, "cache"));
    assert.equal(scratchMode, "700", "temporary project data must stay owner-only");
    assert.equal(existsSync(scratch), false, "normal worker exit must remove scratch");
    assert.deepEqual(scratchEntries(), before, "no new host scratch remains");
    assert.deepEqual(readdirSync(project), ["allowed.txt"]);
    assert.equal(readFileSync(join(project, "allowed.txt"), "utf8"), "EDIT");
    assert.equal(readFileSync(join(sentinel, "private.txt"), "utf8"), "DENIED_HOST_DATA\n");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(sentinel, { recursive: true, force: true });
  }
});

test("a failing worker command still reaps its private scratch", () => {
  const project = mkdtempSync(join(tmpdir(), "foundry-scratch-failure-"));
  try {
    const before = scratchEntries();
    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--workspace",
        resolve(project),
        "--command",
        'printf \'%s\\n\' "$TMPDIR"; touch "$TMPDIR/generated"; exit 7',
      ],
      { cwd: project, encoding: "utf8", timeout: 18_000, maxBuffer: 100_000 },
    );
    assert.equal(result.status, 7, result.stderr);
    assert.equal(existsSync(result.stdout.trim()), false);
    assert.deepEqual(scratchEntries(), before);
    assert.deepEqual(readdirSync(project), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
