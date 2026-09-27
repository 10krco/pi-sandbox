import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";

const runner = fileURLToPath(new URL("../foundry-runner.mjs", import.meta.url));

test("the fixed isolated worker may read toolchain but may not edit it or create a replacement", () => {
  const project = mkdtempSync(join(tmpdir(), "foundry-toolchain-"));
  const packageDir = join(project, "node_modules", "fake-package");
  const dependency = join(packageDir, "index.js");
  try {
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(dependency, "IMMUTABLE_DEPENDENCY\n");
    const execute = (command: string) =>
      spawnSync(process.execPath, [runner, "--workspace", resolve(project), "--command", command], {
        cwd: project,
        encoding: "utf8",
        timeout: 18_000,
        maxBuffer: 100_000,
      });
    const read = execute("cat node_modules/fake-package/index.js");
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /IMMUTABLE_DEPENDENCY/);
    for (const unsafe of [
      "printf TAMPERED > node_modules/fake-package/index.js",
      "mkdir -p node_modules/evil-package",
      "rm -f node_modules/fake-package/index.js",
      "ln -sf ../../allowed.txt node_modules/fake-package/index.js",
    ]) {
      const result = execute(unsafe);
      assert.notEqual(result.status, 0, `toolchain mutation was admitted: ${unsafe}`);
      assert.equal(readFileSync(dependency, "utf8"), "IMMUTABLE_DEPENDENCY\n");
    }
    const allowed = execute("printf PROJECT_EDIT_OK > allowed.txt");
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(readFileSync(join(project, "allowed.txt"), "utf8"), "PROJECT_EDIT_OK");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
