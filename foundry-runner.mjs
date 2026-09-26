#!/usr/bin/env node
// Experimental locked-down entry point for Foundry's externally observed G0.
// NOT a general Pi tool: only a trusted host controller may choose workspace.
import { createSandboxManager } from '@carderne/sandbox-runtime';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function argument(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) throw Error(`missing ${name}`);
  return process.argv[i + 1];
}

async function main() {
  if (process.platform !== 'linux') throw Error('Foundry G0 runner only supports Linux');
  const input = resolve(argument('--workspace'));
  if (lstatSync(input).isSymbolicLink() || realpathSync(input) !== input || !statSync(input).isDirectory()) {
    throw Error('workspace must be a canonical, existing directory');
  }
  if (input === '/' || input === '/tmp' || input === '/home' || input === '/root') {
    throw Error('workspace must be narrow');
  }
  const command = argument('--command');
  if (!command) throw Error('empty command');
  const manager = createSandboxManager();
  let child;
  let wrapped = false;
  try {
    // Explicitly ignore all user/project sandbox.json grants and toggles.
    // This policy is host-authored and must be bound to the chosen workspace.
    const seccompDir = fileURLToPath(new URL('../vendor/seccomp', import.meta.resolve('@carderne/sandbox-runtime')));
    await manager.initialize({
      network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true },
      filesystem: {
        denyRead: ['/', join(input, 'protected')],
        // Linux bwrap receives a hidden host root; only code/tooling and the
        // exact project are re-bound. No access to host HOME, /tmp siblings,
        // /var or service sockets. /nix/store is read-only NixOS tooling.
        allowRead: [input, seccompDir, '/bin', '/usr', '/lib', '/lib64',
                    '/nix/store', '/run/current-system/sw', '/etc/ssl',
                    '/etc/ld.so.cache'],
        allowWrite: [input],
        denyWrite: [join(input, 'protected')],
      },
      enableWeakerNestedSandbox: false,
      allowAllUnixSockets: false,
    });
    const shell = '/bin/sh';
    const sandboxed = await manager.wrapWithSandbox(command, shell);
    wrapped = true;
    // Do not inherit provider tokens, agent env, proxy settings or user's HOME.
    child = spawn(shell, ['-c', sandboxed], {
      cwd: input,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent',
             TMPDIR: input, LC_ALL: 'C', TERM: 'dumb' },
      detached: true,
      stdio: 'inherit',
    });
    const kill = () => {
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timeout = setTimeout(kill, 8000);
    process.on('SIGTERM', kill);
    process.on('SIGINT', kill);
    const status = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => done(signal ? 124 : code ?? 125));
    });
    clearTimeout(timeout);
    process.off('SIGTERM', kill);
    process.off('SIGINT', kill);
    return status;
  } finally {
    // An interrupted child may leave descendants; never report a clean exit
    // based on a killed supervisor without checking the external effects.
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already settled */ }
    }
    if (wrapped) manager.cleanupAfterCommand();
    await manager.reset();
  }
}

main().then(code => { process.exitCode = code; }, error => {
  console.error(`Foundry sandbox failed closed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 125;
});
