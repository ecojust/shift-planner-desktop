import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDefaultState } from '../src/defaults.ts';
import { validateSchedule } from '../src/scheduler.ts';
import { captureFrozen, parseFrozenInfo } from './frozen-process.mjs';
import { runtimeInventory, solverSources } from './runtime-files.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platforms = {
  'x86_64-pc-windows-msvc': { id: 'windows-x64', os: 'win32', nodeArch: 'x64', nativeArch: 'x86_64' },
  'x86_64-apple-darwin': { id: 'macos-x64', os: 'darwin', nodeArch: 'x64', nativeArch: 'x86_64' },
  'aarch64-apple-darwin': { id: 'macos-arm64', os: 'darwin', nodeArch: 'arm64', nativeArch: 'arm64' },
};

/** Keep target selection explicit: a Linux run cannot stand in for a native test. */
export function targetConfiguration(target, platformId) {
  const configuration = platforms[target];
  assert.ok(configuration, `Unsupported or missing SHIFT_FLOW_TARGET: ${target}`);
  assert.ok(!platformId || configuration.id === platformId, `Target ${target} does not match platform ${platformId}`);
  return { ...configuration, target };
}

/** Inspect the PE header itself, including PE32+, rather than trusting filenames. */
export function inspectWindowsX64PE(bytes, label = 'executable') {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 64, `${label}: truncated DOS header`);
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ', `${label}: missing DOS signature`);
  const offset = bytes.readUInt32LE(0x3c);
  assert.ok(offset >= 64 && offset + 26 <= bytes.length, `${label}: invalid PE header offset`);
  assert.equal(bytes.readUInt32LE(offset), 0x00004550, `${label}: missing PE signature`);
  const machine = bytes.readUInt16LE(offset + 4);
  const optionalSize = bytes.readUInt16LE(offset + 20);
  assert.ok(optionalSize >= 112 && offset + 24 + optionalSize <= bytes.length, `${label}: truncated PE32+ header`);
  const optionalMagic = bytes.readUInt16LE(offset + 24);
  assert.equal(machine, 0x8664, `${label}: expected AMD64 PE Machine 0x8664, got 0x${machine.toString(16)}`);
  assert.equal(optionalMagic, 0x20b, `${label}: expected PE32+ executable`);
  return { format: 'PE32+', architecture: 'x86_64', machine: '0x8664', optionalMagic: '0x020b', bytes: bytes.length };
}

export function compareVersions(left, right) {
  const parse = value => {
    assert.match(String(value), /^\d+(?:\.\d+){0,2}$/, `Invalid native version: ${value}`);
    return String(value).split('.').map(Number);
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function regularFile(file) { assert.ok(existsSync(file) && statSync(file).isFile(), `Missing executable/file: ${file}`); return file; }
function directory(file) { assert.ok(existsSync(file) && statSync(file).isDirectory(), `Missing directory: ${file}`); return realpathSync(file); }
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options }).trim();
}

function findMacApp(target) {
  if (process.env.SHIFT_FLOW_APP) return directory(resolve(process.env.SHIFT_FLOW_APP));
  const directories = [
    join(projectRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos'),
    join(projectRoot, 'src-tauri', 'target', target, 'release', 'bundle', 'macos'),
  ];
  const candidates = directories.flatMap(parent => existsSync(parent)
    ? readdirSync(parent).filter(name => name.endsWith('.app')).map(name => join(parent, name)) : []);
  assert.equal(candidates.length, 1, `Expected exactly one final .app, found ${candidates.length}; set SHIFT_FLOW_APP to select explicitly`);
  return directory(candidates[0]);
}

function windowsMain(installation) {
  const expected = join(installation, 'shift-flow-desktop.exe');
  if (existsSync(expected)) return regularFile(expected);
  const config = readJson(join(projectRoot, 'src-tauri', 'tauri.conf.json'));
  for (const name of [config.mainBinaryName, config.productName].filter(Boolean)) {
    assert.equal(basename(name), name, 'Main executable name must not contain a path');
    const candidate = join(installation, `${name}.exe`);
    if (existsSync(candidate)) {
      console.log(`Using configured Windows main executable: ${candidate}`);
      return regularFile(candidate);
    }
  }
  const candidates = readdirSync(installation, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.exe$/i.test(entry.name) && !/(uninst|setup|webview|crashpad)/i.test(entry.name))
    .map(entry => join(installation, entry.name));
  assert.equal(candidates.length, 1, `Main Windows executable is ambiguous or missing: ${candidates.join(', ')}`);
  console.log(`Using discovered Windows main executable: ${candidates[0]}`);
  return regularFile(candidates[0]);
}

function isMachO(file) {
  const bytes = readFileSync(file);
  return bytes.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32BE(0));
}

// Bundling may re-sign Mach-O files. Strip only temporary copies, so original
// application bytes remain untouched and a signature is not mistaken for code.
function sameUnsignedMachO(source, installed, temp, index) {
  const originalCopy = join(temp, `original-${index}`), installedCopy = join(temp, `installed-${index}`);
  for (const [from, to] of [[source, originalCopy], [installed, installedCopy]]) {
    copyFileSync(from, to);
    try { run('/usr/bin/codesign', ['--remove-signature', to]); }
    catch (error) {
      if (!String(error.stderr || '').includes('not signed at all')) throw error;
    }
  }
  return readFileSync(originalCopy).equals(readFileSync(installedCopy));
}

function verifyRuntimeProvenance(runtime, configuration, temp) {
  const manifestFile = join(projectRoot, 'solver', 'build', configuration.target, 'manifest.json');
  const manifest = readJson(regularFile(manifestFile));
  assert.equal(manifest.format, 'onedir');
  assert.equal(manifest.target, configuration.target);
  assert.deepEqual(manifest.sources, solverSources(projectRoot, join(projectRoot, 'solver')), 'Solver sources changed after freezing');
  const sourceRuntime = directory(join(projectRoot, 'src-tauri', 'solver-runtime'));
  const original = runtimeInventory(sourceRuntime);
  assert.equal(original.sha256, manifest.runtime.sha256, 'Build runtime no longer matches its manifest');
  const installed = runtimeInventory(runtime);
  assert.deepEqual(Object.keys(installed.files).sort(), Object.keys(original.files).sort(), 'Installed runtime file/link layout changed');
  const signatureChanges = [];
  for (const [name, source] of Object.entries(original.files)) {
    const destination = installed.files[name];
    if (source.link !== undefined) {
      assert.deepEqual(destination, source, `Installed runtime link changed: ${name}`);
      continue;
    }
    assert.ok(destination.sha256 && destination.link === undefined, `Installed runtime file type changed: ${name}`);
    assert.equal(destination.executable, source.executable, `Installed runtime executable mode changed: ${name}`);
    if (destination.sha256 === source.sha256) continue;
    const sourceFile = join(sourceRuntime, name), installedFile = join(runtime, name);
    assert.ok(configuration.os === 'darwin' && isMachO(sourceFile) && isMachO(installedFile), `Installed runtime content changed: ${name}`);
    assert.ok(sameUnsignedMachO(sourceFile, installedFile, temp, signatureChanges.length), `Installed Mach-O code changed beyond its signature: ${name}`);
    signatureChanges.push(name);
  }
  return {
    manifestFile, manifest,
    verification: {
      sourceHashesMatch: true, completeResourceLayoutMatches: true,
      buildRuntimeSha256: original.sha256, installedRuntimeSha256: installed.sha256,
      identicalRuntimeBytes: original.sha256 === installed.sha256,
      fileCount: installed.fileCount, signatureOnlyChanges: signatureChanges,
    },
  };
}

function macArchitecture(file, architecture) {
  const description = run('/usr/bin/file', ['-b', regularFile(file)]);
  assert.ok(description.includes('Mach-O') && new RegExp(`\\b${architecture}\\b`).test(description), `Wrong native architecture: ${file}: ${description}`);
  return description;
}

function auditMac(app, configuration, artifacts) {
  const venv = join(projectRoot, 'solver', '.venv', 'bin', 'python');
  const python = process.env.SHIFT_FLOW_PYTHON || (existsSync(venv) ? venv : 'python3');
  const report = JSON.parse(run(python, [join(projectRoot, 'scripts', 'audit-macos-app.py'), app, '--arch', configuration.nativeArch]));
  writeJson(join(artifacts, `${configuration.id}-macos-app-audit.json`), report);
  assert.equal(report.target_architecture, configuration.nativeArch);
  assert.equal(report.validation.passed, true);
  assert.deepEqual(report.validation.errors, []);
  assert.equal(report.summary.all_macho_objects_contain_target_architecture, true);
  assert.equal(report.summary.all_symlinks_internal_and_resolvable, true);
  assert.equal(compareVersions(report.minimum_system_assessment.effective_declared_minimum, '14.0'), 0, 'App must declare macOS 14');
  assert.ok(report.summary.macos_target_max_minos, 'Native minimum macOS information is missing');
  assert.ok(compareVersions(report.summary.macos_target_max_minos, '14.0') <= 0, 'A native dependency requires newer than macOS 14');
  assert.equal(report.minimum_system_assessment.declaration_understates_observed_minimum, false);
  return report;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(['--target', '--platform-id'].includes(args[index]) && args[index + 1], 'Usage: node scripts/verify-desktop-bundle.mjs [--target <triple>] [--platform-id <id>]');
    options[args[index]] = args[index + 1];
  }
  const configuration = targetConfiguration(options['--target'] || process.env.SHIFT_FLOW_TARGET, options['--platform-id'] || process.env.SHIFT_FLOW_PLATFORM_ID);
  assert.equal(process.platform, configuration.os, 'Final bundles must be verified on their native OS');
  assert.equal(process.arch, configuration.nodeArch, 'Node must run on the requested native CPU architecture');
  const artifacts = join(projectRoot, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), `shift-flow-${configuration.id}-validation-`));
  try {
    let app, runtime, executable, mainExecutable, audit, mainArchitecture, solverArchitecture;
    if (configuration.os === 'darwin') {
      app = findMacApp(configuration.target);
      audit = auditMac(app, configuration, artifacts);
      const mainName = audit.bundle.CFBundleExecutable;
      assert.equal(typeof mainName, 'string');
      assert.equal(basename(mainName), mainName, 'Invalid app main executable path');
      assert.ok(mainName && mainName !== '.' && mainName !== '..');
      mainExecutable = join(app, 'Contents', 'MacOS', mainName);
      runtime = directory(join(app, 'Contents', 'Resources', 'solver-runtime'));
      executable = regularFile(join(runtime, 'shiftflow-solver'));
      mainArchitecture = macArchitecture(mainExecutable, configuration.nativeArch);
      solverArchitecture = macArchitecture(executable, configuration.nativeArch);
    } else {
      assert.ok(process.env.SHIFT_FLOW_INSTALLED_APP, 'SHIFT_FLOW_INSTALLED_APP must point to the real NSIS installation');
      app = directory(resolve(process.env.SHIFT_FLOW_INSTALLED_APP));
      mainExecutable = windowsMain(app);
      runtime = directory(join(app, 'solver-runtime'));
      executable = regularFile(join(runtime, 'shiftflow-solver.exe'));
      mainArchitecture = inspectWindowsX64PE(readFileSync(mainExecutable), mainExecutable);
      solverArchitecture = inspectWindowsX64PE(readFileSync(executable), executable);
    }
    directory(join(runtime, '_internal'));
    const provenance = verifyRuntimeProvenance(runtime, configuration, temp);
    const executionOptions = {
      cwd: temp, env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
      startupTimeoutMs: 120_000, solveTimeoutMs: 20_000, finishTimeoutMs: 5_000,
    };
    console.log(`Verifying final installed ${configuration.id} solver: ${executable}`);
    const infoRun = await captureFrozen(executable, ['--info', '--hosted'], executionOptions);
    const info = parseFrozenInfo(infoRun);
    const requiredVersion = readFileSync(join(projectRoot, 'solver', 'requirements.txt'), 'utf8').match(/^ortools==([^\s#]+)\s*$/m)?.[1];
    assert.ok(requiredVersion, 'Missing pinned OR-Tools version');
    assert.equal(info.version, requiredVersion);
    assert.deepEqual(info, provenance.manifest.solverInfo, 'Installed engine version differs from build manifest');
    const selfTestRun = await captureFrozen(executable, ['--self-test', '--hosted'], executionOptions);
    const selfTest = parseFrozenInfo(selfTestRun, true);
    assert.equal(selfTest.version, requiredVersion);
    const state = makeDefaultState('2026-10');
    state.assignments = [];
    assert.equal(state.employees.length, 12);
    assert.deepEqual(state.shifts.map(shift => shift.required), [2, 2, 1]);
    const requestId = `bundle-${configuration.id}-${process.env.GITHUB_RUN_ID || 'local'}`;
    const request = { protocolVersion: 1, requestId, state, options: { timeLimitSeconds: 5, allowPartial: false, seed: 1010 } };
    const execution = await captureFrozen(executable, ['--hosted'], { ...executionOptions, input: JSON.stringify(request) });
    const result = JSON.parse(execution.stdout);
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.requestId, requestId);
    assert.equal(result.engine, 'ortools-cp-sat');
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(result.status), result.message);
    assert.equal(result.assignments.length, 155);
    assert.equal(result.stats.shortageCount, 0);
    const independentRuleIssues = validateSchedule({ ...state, assignments: result.assignments });
    assert.deepEqual(independentRuleIssues, []);
    const nativeReport = {
      target: configuration.target, platformId: configuration.id, os: process.platform, nodeArchitecture: process.arch,
      commit: process.env.GITHUB_SHA || null, buildRun: process.env.GITHUB_RUN_ID || null, generatedAt: new Date().toISOString(),
      app, mainExecutable, runtime, mainArchitecture, solverArchitecture,
      info, selfTest, startupSeconds: infoRun.elapsedSeconds, selfTestSeconds: selfTestRun.elapsedSeconds,
      checkedInstalledResourceLayout: true, checkedInstalledNSISLayout: configuration.os === 'win32',
      provenance: provenance.verification,
      ...(audit ? { requiredMacOS: audit.minimum_system_assessment.effective_declared_minimum, observedNativeMinimumMacOS: audit.summary.macos_target_max_minos } : {}),
      limitations: ['Main application GUI and manual installation were not exercised by this script.', 'Code signing and notarization are not certified by these checks.'],
    };
    const monthReport = {
      buildCommit: process.env.GITHUB_SHA || null, buildRun: process.env.GITHUB_RUN_ID || null,
      target: configuration.target, platformId: configuration.id, fixture: 'Built-in demo; no user data',
      month: state.month, employeeCount: state.employees.length, shiftsPerDay: [2, 2, 1], searchLimitSeconds: 5,
      status: result.status, assignmentCount: result.assignments.length, shortageCount: result.stats.shortageCount,
      independentRuleIssues, solverStats: result.stats, elapsedSeconds: execution.elapsedSeconds,
      stages: execution.stages, checkedAppRuntime: true,
    };
    writeJson(join(artifacts, `${configuration.id}-native-validation.json`), nativeReport);
    writeJson(join(artifacts, `${configuration.id}-month-schedule-validation.json`), monthReport);
    copyFileSync(provenance.manifestFile, join(artifacts, `${configuration.id}-solver-manifest.json`));
    console.log(JSON.stringify({ nativeValidation: nativeReport, monthValidation: monthReport }, null, 2));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Desktop bundle validation failed: ${error.stack || error}`); process.exitCode = 1; });
}
