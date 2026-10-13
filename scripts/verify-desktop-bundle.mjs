import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDefaultState } from '../src/defaults.ts';
import { monthlyHoursByEmployee, resolveHoursState } from '../src/hours.ts';
import { datesOfMonth, validateSchedule } from '../src/scheduler.ts';
import { captureFrozen, parseFrozenInfo } from './frozen-process.mjs';
import { runtimeInventory, solverSources } from './runtime-files.mjs';
import { verifyMacSignature } from './verify-macos-signature.mjs';
import { validateBuildVersion } from './build-version.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platforms = {
  'x86_64-pc-windows-msvc': { id: 'windows-x64', os: 'win32', nodeArch: 'x64', nativeArch: 'x86_64' },
  'x86_64-apple-darwin': { id: 'macos-x64', os: 'darwin', nodeArch: 'x64', nativeArch: 'x86_64' },
  'aarch64-apple-darwin': { id: 'macos-arm64', os: 'darwin', nodeArch: 'arm64', nativeArch: 'arm64' },
};

export function makeBundleScheduleFixtures() {
  const base = makeDefaultState('2026-10');
  base.assignments = [];
  const coverage = {
    ...base,
    employees: base.employees.map(employee => ({ ...employee, minHoursPerMonth: 0, minHoursPerWeek: 0 })),
  };
  // Retain the historical fixture/report key for native-workflow consumers.
  // A normal 144-hour reference is no longer an infeasibility fixture: staffing
  // can exceed the daily minimum. 744 hours cannot fit these eight-hour shifts.
  const reference = {
    ...base,
    employees: base.employees.map(employee => ({ ...employee, minHoursPerMonth: 744, minHoursPerWeek: 0 })),
  };
  const weighted = {
    ...base, teamName: 'Installed runtime hours and weekday-weight verification',
    employees: base.employees.slice(0, 2).map(employee => ({
      ...employee, minHoursPerMonth: 120, minHoursPerWeek: 14, eligibleShiftIds: ['day'],
    })),
    shifts: [{ ...base.shifts[0], id: 'day', required: 1 }],
    rules: { minRestHours: 11, maxConsecutiveDays: 5, weekdayWeights: { days: [6, 7], percent: 40 } },
  };
  return { coverage: resolveHoursState(coverage), reference: resolveHoursState(reference), weighted: resolveHoursState(weighted) };
}

/** Every entry point runs these against its delivered solver, then independently
 * checks returned rosters. The coverage fixture is not the default-hours demo. */
export async function verifyScheduleFixtures(runSolver, requestIdPrefix) {
  const fixtures = makeBundleScheduleFixtures();
  async function solve(name) {
    const state = fixtures[name], requestId = `${requestIdPrefix}-${name}`;
    const request = { protocolVersion: 1, requestId, state, options: { timeLimitSeconds: 5, allowPartial: false, seed: 1010 } };
    const execution = await runSolver(request), result = JSON.parse(execution.stdout);
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.requestId, requestId);
    assert.equal(result.engine, 'ortools-cp-sat');
    return { state, result, execution };
  }
  function feasible(check, minimumCount) {
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(check.result.status), check.result.message);
    assert.ok(check.result.assignments.length >= minimumCount, 'A feasible roster must cover at least the baseline shift count');
    assert.equal(check.result.stats.shortageCount, 0);
    // Check daily coverage directly, rather than relying on a fixed total count
    // or letting extra assignments on one date hide a shortage on another.
    for (const date of datesOfMonth(check.state.month)) {
      for (const shift of check.state.shifts) {
        const count = check.result.assignments.filter(item => item.date === date && item.shiftId === shift.id).length;
        assert.ok(count >= shift.required, `${date} ${shift.id}: daily minimum coverage is missing`);
      }
    }
    const issues = validateSchedule({ ...check.state, assignments: check.result.assignments });
    assert.deepEqual(issues, [], 'Actual app schedule must pass independent TypeScript rules');
    return issues;
  }
  const coverage = await solve('coverage');
  assert.equal(coverage.state.employees.length, 12);
  assert.deepEqual(coverage.state.shifts.map(shift => shift.required), [2, 2, 1]);
  const independentRuleIssues = feasible(coverage, 155);

  const reference = await solve('reference');
  assert.ok(reference.state.employees.every(employee => employee.minHoursPerMonth === 744));
  assert.equal(reference.result.status, 'INFEASIBLE', 'A 744-hour monthly minimum cannot fit the available eight-hour shifts and weekly caps');
  assert.equal(Object.hasOwn(reference.result, 'assignments'), false, 'An infeasible model must not supply a replacement roster');
  assert.ok(reference.result.issues.some(issue => issue.type === 'monthly-min-hours'));

  const weighted = await solve('weighted');
  const weightedIssues = feasible(weighted, datesOfMonth(weighted.state.month).length);
  const monthlyHours = Object.fromEntries(monthlyHoursByEmployee({ ...weighted.state, assignments: weighted.result.assignments }));
  for (const employee of weighted.state.employees) assert.ok(monthlyHours[employee.id] >= employee.minHoursPerMonth);
  const weeks = new Map();
  for (const date of datesOfMonth(weighted.state.month)) {
    const day = new Date(`${date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    const week = day.toISOString().slice(0, 10);
    weeks.set(week, [...(weeks.get(week) ?? []), date]);
  }
  const rule = weighted.state.rules.weekdayWeights;
  const weeklyQuotas = [...weeks].map(([week, dates]) => {
    const assignments = weighted.result.assignments.filter(item => dates.includes(item.date) && item.shiftId !== 'off');
    const selectedDates = dates.filter(date => rule.days.includes((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7 + 1));
    const otherDates = dates.filter(date => !selectedDates.includes(date));
    const selectedCount = assignments.filter(item => selectedDates.includes(item.date)).length;
    const otherCount = assignments.length - selectedCount;
    // Independently find a full-week count W whose rounded original weekday
    // shares match this month's segment. Do not impose per-shift weekly quotas.
    const candidates = [];
    for (let total = 0; total <= weighted.state.employees.length * 7; total++) {
      const fullSelected = Math.ceil(total * rule.percent / 100);
      const selected = Math.ceil(fullSelected * selectedDates.length / rule.days.length);
      const other = rule.days.length === 7 ? 0 : Math.ceil((total - fullSelected) * otherDates.length / (7 - rule.days.length));
      if (selected === selectedCount && other === otherCount) candidates.push(total);
    }
    assert.ok(candidates.length, `${week}: actual counts violate the configured weekday share`);
    for (const group of [selectedDates, otherDates]) {
      const counts = group.map(date => assignments.filter(item => item.date === date).length);
      if (counts.length) assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${week}: weekday group is not evenly distributed`);
    }
    return { week, totalTarget: assignments.length, selectedTarget: selectedCount, assignmentCount: assignments.length, selectedCount, fullWeekCountCandidates: candidates };
  });
  return { ...coverage, independentRuleIssues, constraintChecks: {
    defaultReference: { fixtureKind: 'impossible-monthly-minimum', status: reference.result.status, minimumHoursPerEmployee: 744, issueTypes: reference.result.issues.map(issue => issue.type), suppliedAssignments: false },
    positiveMinimumsAndWeights: { status: weighted.result.status, month: weighted.state.month, employeeCount: weighted.state.employees.length,
      minHoursPerMonth: 120, minHoursPerWeek: 14, weekdayWeights: weighted.state.rules.weekdayWeights,
      assignmentCount: weighted.result.assignments.length, shortageCount: weighted.result.stats.shortageCount,
      monthlyHours, weeklyQuotas, independentRuleIssues: weightedIssues, elapsedSeconds: weighted.execution.elapsedSeconds },
  } };
}

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
  const compiledBuild = readJson(join(projectRoot, 'dist', 'build-info.json'));
  const buildVersion = validateBuildVersion(compiledBuild.buildVersion);
  if (process.env.SHIFT_FLOW_BUILD_VERSION !== undefined) {
    assert.equal(buildVersion, validateBuildVersion(process.env.SHIFT_FLOW_BUILD_VERSION), 'Compiled UI build number differs from workflow');
  }
  assert.equal(process.platform, configuration.os, 'Final bundles must be verified on their native OS');
  assert.equal(process.arch, configuration.nodeArch, 'Node must run on the requested native CPU architecture');
  const artifacts = join(projectRoot, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), `shift-flow-${configuration.id}-validation-`));
  try {
    let app, runtime, executable, mainExecutable, audit, signature, mainArchitecture, solverArchitecture;
    if (configuration.os === 'darwin') {
      app = findMacApp(configuration.target);
      signature = verifyMacSignature(app);
      writeJson(join(artifacts, `${configuration.id}-macos-signature-validation.json`), signature);
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
    const requestId = `bundle-${configuration.id}-${process.env.GITHUB_RUN_ID || 'local'}`;
    const { state, result, execution, independentRuleIssues, constraintChecks } = await verifyScheduleFixtures(
      request => captureFrozen(executable, ['--hosted'], { ...executionOptions, input: JSON.stringify(request) }), requestId,
    );
    const nativeReport = {
      target: configuration.target, platformId: configuration.id, os: process.platform, nodeArchitecture: process.arch,
      commit: process.env.GITHUB_SHA || null, buildRun: process.env.GITHUB_RUN_ID || null, buildVersion, generatedAt: new Date().toISOString(),
      app, mainExecutable, runtime, mainArchitecture, solverArchitecture,
      info, selfTest, startupSeconds: infoRun.elapsedSeconds, selfTestSeconds: selfTestRun.elapsedSeconds,
      checkedInstalledResourceLayout: true, checkedInstalledNSISLayout: configuration.os === 'win32',
      provenance: provenance.verification,
      ...(signature ? { signature, adHocSigned: true, developerIdSigned: false, notarized: false } : {}),
      ...(audit ? { requiredMacOS: audit.minimum_system_assessment.effective_declared_minimum, observedNativeMinimumMacOS: audit.summary.macos_target_max_minos } : {}),
      limitations: ['Main application GUI and manual installation were not exercised by this script.', 'Apple Developer ID, notarization, Gatekeeper acceptance and Windows publisher trust are not certified by these checks.'],
    };
    const monthReport = {
      buildCommit: process.env.GITHUB_SHA || null, buildRun: process.env.GITHUB_RUN_ID || null, buildVersion,
      target: configuration.target, platformId: configuration.id, fixture: '12-person staffing fixture with zero hour minimums; no user data',
      month: state.month, employeeCount: state.employees.length, shiftsPerDay: [2, 2, 1], searchLimitSeconds: 5,
      status: result.status, assignmentCount: result.assignments.length, shortageCount: result.stats.shortageCount,
      independentRuleIssues, solverStats: result.stats, elapsedSeconds: execution.elapsedSeconds,
      constraintChecks,
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
