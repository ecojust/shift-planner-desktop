import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureFrozen, parseFrozenInfo } from '../../scripts/frozen-process.mjs';
import { runtimeInventory } from '../../scripts/runtime-files.mjs';

const node = (script, options = {}) => captureFrozen(process.execPath, ['-e', script], options);

test('frozen process gives slow startup its own budget and accepts a path with spaces', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shift flow 诊断 '));
  try {
    const result = await node(`
      console.error('SHIFTFLOW_STAGE_V1:loading');
      setTimeout(() => {
        console.error('SHIFTFLOW_STAGE_V1:solving');
        setTimeout(() => { console.error('SHIFTFLOW_STAGE_V1:finishing'); console.log('{"ok":true}'); }, 20);
      }, 200);
    `, { cwd: directory, startupTimeoutMs: 3000, solveTimeoutMs: 100 });
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    assert.deepEqual(result.stages.map(item => item.stage), ['loading', 'solving', 'finishing']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('frozen process times out loading and retains bounded diagnostics', async () => {
  await assert.rejects(node(`console.error('SHIFTFLOW_STAGE_V1:loading'); console.error('native import diagnostic'); setInterval(() => {}, 1000);`,
    { startupTimeoutMs: 300, hardTimeoutMs: 3000 }), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.diagnostics.stage, 'loading');
    assert.match(error.message, /native import diagnostic/);
    assert.ok(error.diagnostics.elapsedSeconds < 3);
    return true;
  });
});

test('frozen self-test deadline starts at solving and repeated markers cannot extend it', async () => {
  await assert.rejects(node(`console.error('SHIFTFLOW_STAGE_V1:solving'); setInterval(() => console.error('SHIFTFLOW_STAGE_V1:solving'), 20);`,
    { startupTimeoutMs: 3000, solveTimeoutMs: 100 }), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.diagnostics.stage, 'solving');
    assert.equal(error.diagnostics.stages.length, 1);
    assert.ok(error.diagnostics.elapsedSeconds < 2);
    return true;
  });
});

test('frozen process caps actual output bytes and returns spawn failures', async () => {
  await assert.rejects(node(`console.log('x'.repeat(20000)); setInterval(() => {}, 1000);`, { stdoutLimit: 100 }), /标准输出超过上限/);
  await assert.rejects(node(`console.error('x'.repeat(20000)); setInterval(() => {}, 1000);`, { stderrLimit: 100 }), /诊断输出超过上限/);
  await assert.rejects(captureFrozen(join(tmpdir(), 'shiftflow-nonexistent-binary'), []), /无法启动求解器/);
});

test('frozen process closes stdin and reads output without pipe deadlock', async () => {
  const result = await node(`const fs=require('node:fs'); const input=fs.readFileSync(0); process.stderr.write('x'.repeat(100000)); console.log(JSON.stringify({bytes:input.length}));`,
    { input: 'y'.repeat(100000), startupTimeoutMs: 3000 });
  assert.equal(JSON.parse(result.stdout).bytes, 100000);
});

test('timeout terminates the child process tree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shift-flow-tree '));
  const heartbeat = join(directory, 'heartbeat');
  const descendant = `const fs=require('node:fs'); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
  try {
    await assert.rejects(node(`
      const fs = require('node:fs');
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'});
      const ready = setInterval(() => { if(fs.existsSync(${JSON.stringify(heartbeat)})) { clearInterval(ready); console.error('SHIFTFLOW_STAGE_V1:solving'); } }, 10);
      setInterval(() => {}, 1000);
    `, { startupTimeoutMs: 3000, solveTimeoutMs: 150 }), /TIMEOUT:/);
    const after = readFileSync(heartbeat, 'utf8');
    await delay(150);
    assert.equal(readFileSync(heartbeat, 'utf8'), after, 'grandchild must stop producing output');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('frozen validation requires a real optimal self-test result', () => {
  const info = { engine: 'ortools-cp-sat', protocolVersion: 1, version: '9.14', local: true };
  assert.equal(parseFrozenInfo({ stdout: JSON.stringify(info), stage: 'finishing' }).engine, 'ortools-cp-sat');
  assert.throws(() => parseFrozenInfo({ stdout: JSON.stringify(info), stage: 'finishing' }, true), /实际求解自检/);
  assert.equal(parseFrozenInfo({ stdout: JSON.stringify({ ...info, selfTest: true, status: 'OPTIMAL' }) }, true).selfTest, true);
});

test('onedir inventory detects changed or missing native resources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shift flow runtime '));
  try {
    mkdirSync(join(directory, '_internal'));
    writeFileSync(join(directory, 'shiftflow-solver'), 'bootloader');
    writeFileSync(join(directory, '.gitkeep'), '');
    const native = join(directory, '_internal', 'native-library');
    writeFileSync(native, 'library-v1');
    const initial = runtimeInventory(directory);
    assert.equal(initial.fileCount, 2);
    writeFileSync(native, 'library-v2');
    assert.notEqual(runtimeInventory(directory).sha256, initial.sha256);
    rmSync(native);
    assert.notEqual(runtimeInventory(directory).sha256, initial.sha256);
    if (process.platform !== 'win32') {
      symlinkSync('../../outside', native);
      assert.throws(() => runtimeInventory(directory), /目录内/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
