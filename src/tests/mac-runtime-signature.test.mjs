import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAC_SIGNATURE_FORMAT, hasCurrentMacSignatureFormat, sealMacSolverRuntime } from '../../scripts/seal-macos-runtime.mjs';

function fixture(context) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'shift-flow-framework-signature-')));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'runtime');
  const framework = join(root, '_internal', 'Python.framework');
  mkdirSync(join(framework, 'Resources'), { recursive: true });
  const nativeBytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
  const solver = join(root, 'shiftflow-solver'), python = join(framework, 'Python');
  const library = join(root, '_internal', 'native-extension.so');
  for (const file of [solver, python, library]) writeFileSync(file, nativeBytes);
  writeFileSync(join(framework, 'Resources', 'Info.plist'), '<plist/>');
  const calls = [];
  function execute(command, args) {
    calls.push({ command, args });
    const value = args[1] === 'CFBundleExecutable' ? 'Python' : args[1] === 'CFBundlePackageType' ? 'FMWK' : '';
    return { status: 0, stdout: value, stderr: '' };
  }
  return { temporary, root, framework, solver, python, library, calls, execute };
}

test('macOS rejects legacy/unverified signing caches while other systems keep existing cache semantics', () => {
  assert.equal(hasCurrentMacSignatureFormat({}, 'darwin'), false);
  assert.equal(hasCurrentMacSignatureFormat({ macSignatureFormat: MAC_SIGNATURE_FORMAT }, 'darwin'), false);
  assert.equal(hasCurrentMacSignatureFormat({ macSignatureFormat: 0, macSignatures: { strictVerification: true } }, 'darwin'), false);
  assert.equal(hasCurrentMacSignatureFormat({ macSignatureFormat: MAC_SIGNATURE_FORMAT, macSignatures: { strictVerification: true } }, 'darwin'), true);
  assert.equal(hasCurrentMacSignatureFormat({}, 'win32'), true);
  assert.equal(hasCurrentMacSignatureFormat({}, 'linux'), true);
});

test('seals the complete minimal framework, verifies every native object, and does not re-sign extension libraries', context => {
  const f = fixture(context);
  const originalLibrary = readFileSync(f.library);
  const result = sealMacSolverRuntime(f.root, { platform: 'darwin', execute: f.execute });
  assert.equal(result.strictVerification, true);
  assert.equal(result.nativeObjectCount, 3);
  assert.equal(result.frameworks.length, 1);
  assert.equal(result.frameworks[0].path, '_internal/Python.framework');
  assert.equal(result.developerIdSigned, false);
  const signatures = f.calls.filter(call => call.args.includes('--sign'));
  assert.equal(signatures.length, 1);
  assert.deepEqual(signatures[0].args, ['--force', '--sign', '-', '--timestamp=none', f.framework]);
  assert.ok(!signatures[0].args.includes('--deep'));
  for (const path of [f.framework, f.solver, f.python, f.library]) {
    assert.ok(f.calls.some(call => call.args.includes('--verify') && call.args.includes('--strict') && call.args.at(-1) === path));
  }
  assert.deepEqual(readFileSync(f.library), originalLibrary);
});

test('invalid framework metadata stops before signing any object', context => {
  const f = fixture(context);
  const execute = (command, args) => {
    const result = f.execute(command, args);
    if (args[1] === 'CFBundleExecutable') result.stdout = 'UnexpectedExecutable';
    return result;
  };
  assert.throws(() => sealMacSolverRuntime(f.root, { platform: 'darwin', execute }), /Unexpected CFBundleExecutable/);
  assert.ok(!f.calls.some(call => call.args.includes('--sign')));
});

test('an invalid native signature prevents a successful signing attestation', context => {
  const f = fixture(context);
  const execute = (command, args) => {
    const result = f.execute(command, args);
    if (args.includes('--verify') && args.at(-1) === f.library) {
      return { status: 1, stdout: '', stderr: 'code has no resources but signature indicates they must be present' };
    }
    return result;
  };
  assert.throws(() => sealMacSolverRuntime(f.root, { platform: 'darwin', execute }), /code has no resources/);
});

test('framework aliases resolving outside staging are rejected before any signing command', context => {
  const f = fixture(context);
  const alias = join(f.framework, 'outside');
  try { symlinkSync(f.temporary, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { context.skip('Host cannot create symbolic links'); return; }
    throw error;
  }
  assert.throws(() => sealMacSolverRuntime(f.root, { platform: 'darwin', execute: f.execute }), /escapes the runtime/);
  assert.equal(f.calls.length, 0);
});

test('non-macOS builds do not invoke macOS tools or inspect a macOS runtime', () => {
  const execute = () => { throw new Error('Unexpected macOS command'); };
  assert.equal(sealMacSolverRuntime('not-a-real-directory', { platform: 'win32', execute }), null);
  assert.equal(sealMacSolverRuntime('not-a-real-directory', { platform: 'linux', execute }), null);
});
