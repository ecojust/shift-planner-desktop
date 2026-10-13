import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRuntimeStaging, replaceRuntimeDirectory, retryWindowsFileLock } from '../../scripts/runtime-directory.mjs';

const locked = code => Object.assign(new Error(`file operation: ${code}`), { code });
const windows = { platform: 'win32', attempts: 3, delayMs: 1, wait: async () => {} };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'shiftflow-runtime-swap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stagingRoot = join(root, 'stage'), staging = join(stagingRoot, 'payload');
  const destination = join(root, 'runtime'), backup = join(stagingRoot, 'previous');
  mkdirSync(staging, { recursive: true }); mkdirSync(destination);
  writeFileSync(join(staging, 'solver.txt'), 'new'); writeFileSync(join(destination, 'solver.txt'), 'old');
  return { root, stagingRoot, staging, destination, backup };
}

test('Windows file operations retry transient locks with awaited delays and preserve results', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const events = []; let attempts = 0;
    const value = await retryWindowsFileLock(async () => {
      events.push('operation');
      if (++attempts < 3) throw locked(code);
      return 'installed';
    }, { ...windows, wait: async delay => { assert.equal(delay, 1); events.push('wait'); } });
    assert.equal(value, 'installed');
    assert.deepEqual(events, ['operation', 'wait', 'operation', 'wait', 'operation']);
  }
});

test('persistent Windows locks stop at the attempt limit and throw the original error', async () => {
  const error = locked('EPERM'); let attempts = 0, waits = 0;
  await assert.rejects(retryWindowsFileLock(async () => { attempts += 1; throw error; },
    { ...windows, wait: async () => { waits += 1; } }), actual => actual === error);
  assert.equal(attempts, 3); assert.equal(waits, 2);
});

test('non-Windows locks and unrelated errors fail immediately', async () => {
  for (const [platform, code] of [['darwin', 'EPERM'], ['linux', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'ENOTEMPTY']]) {
    const error = locked(code); let attempts = 0;
    await assert.rejects(retryWindowsFileLock(async () => { attempts += 1; throw error; },
      { ...windows, platform, wait: async () => assert.fail('must not retry') }), actual => actual === error);
    assert.equal(attempts, 1);
  }
});

test('transient backup and replacement locks still publish the new runtime', async t => {
  const paths = fixture(t), calls = new Map();
  await replaceRuntimeDirectory(paths.staging, paths.destination, paths.backup, { ...windows,
    rename: async (from, to) => {
      const attempt = (calls.get(from) ?? 0) + 1; calls.set(from, attempt);
      if (attempt === 1) throw locked('EPERM');
      await rename(from, to);
    } });
  assert.equal(readFileSync(join(paths.destination, 'solver.txt'), 'utf8'), 'new');
  assert.equal(readFileSync(join(paths.backup, 'solver.txt'), 'utf8'), 'old');
  assert.equal(calls.get(paths.destination), 2); assert.equal(calls.get(paths.staging), 2);
  await cleanupRuntimeStaging(paths.stagingRoot, paths.backup, windows);
  assert.equal(existsSync(paths.stagingRoot), false);
  assert.equal(readFileSync(join(paths.destination, 'solver.txt'), 'utf8'), 'new');
});

test('persistent replacement failure restores the old directory, retrying restore locks', async t => {
  const paths = fixture(t), error = locked('EPERM'); let restores = 0;
  await assert.rejects(replaceRuntimeDirectory(paths.staging, paths.destination, paths.backup, { ...windows,
    rename: async (from, to) => {
      if (from === paths.staging) throw error;
      if (from === paths.backup && ++restores === 1) throw locked('EACCES');
      await rename(from, to);
    } }), actual => actual === error);
  assert.equal(restores, 2);
  assert.equal(readFileSync(join(paths.destination, 'solver.txt'), 'utf8'), 'old');
  assert.equal(existsSync(paths.backup), false);
  await cleanupRuntimeStaging(paths.stagingRoot, paths.backup, { ...windows, failure: error });
  assert.equal(existsSync(paths.stagingRoot), false);
  assert.equal(readFileSync(join(paths.destination, 'solver.txt'), 'utf8'), 'old');
});

test('a failed backup move never removes or replaces the old runtime', async t => {
  const paths = fixture(t), error = locked('EBUSY');
  await assert.rejects(replaceRuntimeDirectory(paths.staging, paths.destination, paths.backup, { ...windows,
    rename: async () => { throw error; } }), actual => actual === error);
  await cleanupRuntimeStaging(paths.stagingRoot, paths.backup, { ...windows, failure: error });
  assert.equal(readFileSync(join(paths.destination, 'solver.txt'), 'utf8'), 'old');
});

test('failed rollback retains the old backup and both errors without destructive cleanup', async t => {
  const paths = fixture(t), installError = locked('EPERM'), restoreError = locked('EACCES');
  let failure;
  try {
    await replaceRuntimeDirectory(paths.staging, paths.destination, paths.backup, { ...windows,
      rename: async (from, to) => {
        if (from === paths.staging) throw installError;
        if (from === paths.backup) throw restoreError;
        await rename(from, to);
      } });
  } catch (error) { failure = error; }
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [installError, restoreError]);
  assert.equal(failure.cause, installError);
  // Another process recreating destination must not cause backup deletion.
  mkdirSync(paths.destination);
  const result = await cleanupRuntimeStaging(paths.stagingRoot, paths.backup, { ...windows, failure,
    remove: async () => assert.fail('recoverable backup must remain') });
  assert.deepEqual(result, { preserved: true });
  assert.equal(readFileSync(join(paths.backup, 'solver.txt'), 'utf8'), 'old');
  assert.equal(readFileSync(join(paths.staging, 'solver.txt'), 'utf8'), 'new');
});

test('cleanup retries locks, reports persistent cleanup failure and does not mask a build failure', async t => {
  const paths = fixture(t); let calls = 0;
  await cleanupRuntimeStaging(paths.stagingRoot, paths.backup, { ...windows, remove: async (...args) => {
    if (++calls === 1) throw locked('EBUSY');
    return rm(...args);
  } });
  assert.equal(calls, 2); assert.equal(existsSync(paths.stagingRoot), false);
  const error = locked('EPERM'), failure = new Error('original build failure');
  const options = { ...windows, remove: async () => { throw error; } };
  await assert.rejects(cleanupRuntimeStaging(paths.stagingRoot, paths.backup, options), actual => actual === error);
  assert.deepEqual(await cleanupRuntimeStaging(paths.stagingRoot, paths.backup, { ...options, failure }),
    { preserved: true, cleanupError: error });
});
