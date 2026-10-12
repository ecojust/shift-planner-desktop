import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeInventory } from './runtime-files.mjs';

// Download and inspect a published artifact without changing its signature,
// quarantine metadata or bytes. Signing/Gatekeeper failures are diagnostic data.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {
  repo: 'ecojust/shift-planner-desktop', tag: 'desktop-v1.1.0-38277333420',
  asset: 'shift-flow-macos-arm64.dmg', output: 'artifacts/macos-download-diagnostics', launch: 'true',
};
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const workflowEscape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

function optionsFrom(args) {
  const options = { ...defaults };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    assert.ok(args[index]?.startsWith('--') && Object.hasOwn(defaults, key) && args[index + 1], `Invalid argument ${args[index]}`);
    options[key] = args[index + 1];
  }
  assert.match(options.repo, /^[\w.-]+\/[\w.-]+$/);
  assert.equal(basename(options.asset), options.asset);
  assert.ok(options.asset.endsWith('.dmg'));
  assert.ok(['true', 'false'].includes(options.launch));
  return options;
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true });
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), diagnosticRun: process.env.GITHUB_RUN_ID || null,
    source: { repository: options.repo, tag: options.tag, assetName: options.asset },
    completed: false, commands: [],
    limitations: [
      'The downloaded DMG, app code, signatures and quarantine attributes are not changed by these checks.',
      'A non-quarantined direct executable launch does not demonstrate Finder/Gatekeeper acceptance or complete GUI functionality.',
      'The runner is native Apple Silicon, not the user\'s M5 hardware.',
      'Code-signing verification is distinct from Developer ID identity, notarization and Gatekeeper acceptance.',
    ],
  };
  let commandNumber = 0, mounted = false, workspace;
  function recordCommand(label, command, args, { timeout = 120_000, stdoutFile } = {}) {
    const started = Date.now(), log = `${String(++commandNumber).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    let status = 0, stdout = '', stderr = '', signal = null, launchError = null, descriptor;
    try {
      if (stdoutFile) descriptor = openSync(stdoutFile, 'w');
      const result = spawnSync(command, args, {
        encoding: 'utf8', shell: false, timeout, maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', stdoutFile ? descriptor : 'pipe', 'pipe'],
      });
      status = result.status;
      stdout = result.stdout || '';
      stderr = result.stderr || '';
      signal = result.signal || null;
      launchError = result.error ? String(result.error.code || result.error.message) : null;
    } catch (error) {
      status = Number.isInteger(error.status) ? error.status : null;
      signal = error.signal || null;
      stdout = error.stdout?.toString('utf8') || '';
      stderr = error.stderr?.toString('utf8') || '';
      if (error.code) launchError = String(error.code);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const result = { label, command, args, status, signal, launchError, seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      stdout, stderr, stdoutFile: stdoutFile || null };
    writeFileSync(join(output, `${log}.stdout.txt`), stdout);
    writeFileSync(join(output, `${log}.stderr.txt`), stderr);
    report.commands.push(result);
    return result;
  }
  function requireSuccess(result) {
    assert.equal(result.status, 0, `${result.label} failed: ${result.stderr || result.launchError || result.signal || result.status}`);
    return result;
  }
  function inspectSignature(label, path) {
    return {
      verify: recordCommand(`${label}-verify-strict`, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', path]),
      description: recordCommand(`${label}-signature-description`, '/usr/bin/codesign', ['--display', '--verbose=4', path]),
      entitlements: recordCommand(`${label}-entitlements`, '/usr/bin/codesign', ['--display', '--entitlements', ':-', path]),
    };
  }
  try {
    assert.equal(process.platform, 'darwin', 'Run these diagnostics on macOS');
    assert.equal(process.arch, 'arm64', 'This diagnostic workflow uses a native Apple Silicon runner');
    report.host = {
      system: recordCommand('system-version', '/usr/bin/sw_vers', []),
      architecture: recordCommand('system-architecture', '/usr/bin/uname', ['-m']),
    };
    const metadata = requireSuccess(recordCommand('github-release-metadata', 'gh', [
      'api', '--allow-escape-sequences', `repos/${options.repo}/releases/tags/${encodeURIComponent(options.tag)}`,
    ]));
    const release = JSON.parse(metadata.stdout);
    const assets = release.assets.filter(asset => asset.name === options.asset);
    assert.equal(assets.length, 1, 'Expected exactly one matching release asset');
    const asset = assets[0];
    assert.equal(asset.state, 'uploaded');
    report.source = { ...report.source, releaseId: release.id, releaseUrl: release.html_url,
      assetId: asset.id, bytes: asset.size, githubDigest: asset.digest || null, publishedAt: release.published_at };
    workspace = mkdtempSync(join(tmpdir(), 'shift-flow-download-diagnostic-'));
    const dmg = join(workspace, options.asset);
    requireSuccess(recordCommand('download-release-dmg', 'gh', [
      'api', '--allow-escape-sequences', '-H', 'Accept: application/octet-stream', `repos/${options.repo}/releases/assets/${asset.id}`,
    ], { stdoutFile: dmg, timeout: 180_000 }));
    const digest = sha256(dmg), expected = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
    report.download = { bytes: statSync(dmg).size, sha256: digest, githubExpectedSha256: expected || null,
      digestMatches: expected ? digest === expected : null, sizeMatches: statSync(dmg).size === asset.size };
    assert.equal(report.download.sizeMatches, true, 'Downloaded size differs from GitHub asset metadata');
    assert.ok(expected, 'GitHub did not provide a SHA-256 asset digest; do not execute unverified content');
    assert.equal(report.download.digestMatches, true, 'Downloaded SHA-256 differs from GitHub asset digest');
    report.dmg = {
      verify: recordCommand('dmg-integrity-verify', '/usr/bin/hdiutil', ['verify', dmg]),
      imageInfo: recordCommand('dmg-image-info', '/usr/bin/hdiutil', ['imageinfo', dmg]),
      signature: recordCommand('dmg-signature-description', '/usr/bin/codesign', ['--display', '--verbose=4', dmg]),
      quarantine: recordCommand('dmg-quarantine', '/usr/bin/xattr', ['-p', 'com.apple.quarantine', dmg]),
      gatekeeper: recordCommand('dmg-gatekeeper-assessment', '/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]),
    };
    requireSuccess(report.dmg.verify);
    const mountpoint = join(workspace, 'mounted');
    mkdirSync(mountpoint);
    requireSuccess(recordCommand('mount-readonly-dmg', '/usr/bin/hdiutil', [
      'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, '-plist', dmg,
    ]));
    mounted = true;
    const apps = readdirSync(mountpoint).filter(name => name.endsWith('.app'));
    assert.equal(apps.length, 1, 'Expected exactly one .app at the disk image root');
    const sourceApp = join(mountpoint, apps[0]), copiedApp = join(workspace, 'copied', apps[0]);
    mkdirSync(dirname(copiedApp));
    requireSuccess(recordCommand('copy-app-preserve-metadata', '/usr/bin/ditto', ['--rsrc', '--extattr', sourceApp, copiedApp]));
    const originalInventory = runtimeInventory(sourceApp), copiedInventory = runtimeInventory(copiedApp);
    report.copy = { sourceApp, copiedApp, sourceSha256: originalInventory.sha256, copiedSha256: copiedInventory.sha256,
      fileCount: copiedInventory.fileCount, unchangedContentsAndLinks: originalInventory.sha256 === copiedInventory.sha256 };
    assert.equal(report.copy.unchangedContentsAndLinks, true, 'Copy changed app contents, executable modes or symlinks');
    const auditCommand = recordCommand('app-macho-audit', 'python3', [join(projectRoot, 'scripts', 'audit-macos-app.py'), copiedApp, '--arch', 'arm64']);
    report.architectureAudit = JSON.parse(auditCommand.stdout);
    writeFileSync(join(output, 'macos-app-audit.json'), `${JSON.stringify(report.architectureAudit, null, 2)}\n`);
    const mainName = report.architectureAudit.bundle.CFBundleExecutable;
    assert.equal(typeof mainName, 'string');
    assert.equal(basename(mainName), mainName);
    assert.ok(mainName && mainName !== '.' && mainName !== '..');
    const mainExecutable = join(copiedApp, 'Contents', 'MacOS', mainName);
    const solver = join(copiedApp, 'Contents', 'Resources', 'solver-runtime', 'shiftflow-solver');
    report.app = {
      copiedBundle: inspectSignature('copied-app', copiedApp),
      originalBundle: { verify: recordCommand('mounted-app-verify-strict', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', sourceApp]) },
      main: inspectSignature('main-executable', mainExecutable),
      solver: inspectSignature('solver-executable', solver),
      quarantine: recordCommand('app-quarantine', '/usr/bin/xattr', ['-p', 'com.apple.quarantine', copiedApp]),
      mainQuarantine: recordCommand('main-quarantine', '/usr/bin/xattr', ['-p', 'com.apple.quarantine', mainExecutable]),
      gatekeeper: recordCommand('app-gatekeeper-assessment', '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', copiedApp]),
      notarizationTicket: recordCommand('app-stapled-ticket', '/usr/bin/xcrun', ['stapler', 'validate', '-v', copiedApp]),
    };
    report.nativeObjects = { checked: 0, failed: [], results: [] };
    for (const item of report.architectureAudit.macho_objects) {
      const file = resolve(copiedApp, item.path);
      assert.ok(file.startsWith(`${copiedApp}/`));
      const verification = recordCommand(`native-object-${report.nativeObjects.checked}`, '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', file]);
      const entry = { path: item.path, status: verification.status, stderr: verification.stderr };
      report.nativeObjects.results.push(entry);
      report.nativeObjects.checked++;
      if (verification.status !== 0) report.nativeObjects.failed.push(entry);
    }
    const quarantineChecks = [report.dmg.quarantine, report.app.quarantine, report.app.mainQuarantine];
    const quarantined = quarantineChecks.some(result => result.status === 0);
    const quarantineKnownAbsent = quarantineChecks.every(result => result.status !== 0 && /No such xattr|No such attribute/i.test(result.stderr));
    const invalidMetadata = report.architectureAudit.validation.passed !== true;
    if (options.launch !== 'true' || !quarantineKnownAbsent || invalidMetadata) {
      report.launch = { attempted: false, reason: options.launch !== 'true' ? 'Disabled by input' : quarantined ? 'Quarantine is present; it was not removed' : !quarantineKnownAbsent ? 'Could not establish that quarantine is absent' : 'Architecture or bundle-path audit failed' };
    } else {
      const started = Date.now();
      const child = spawn(mainExecutable, [], { cwd: dirname(mainExecutable), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', outcome = null;
      const append = (current, bytes) => (current + bytes.toString('utf8')).slice(-120_000);
      child.stdout.on('data', bytes => { stdout = append(stdout, bytes); });
      child.stderr.on('data', bytes => { stderr = append(stderr, bytes); });
      const ended = new Promise(resolvePromise => {
        child.once('error', error => { outcome = { launchError: error.message }; resolvePromise(); });
        child.once('close', (code, signal) => { outcome = { code, signal }; resolvePromise(); });
      });
      await Promise.race([ended, sleep(8000)]);
      const remainedRunning = outcome === null;
      const observationSeconds = Number(((Date.now() - started) / 1000).toFixed(3));
      if (remainedRunning) {
        child.kill('SIGTERM');
        await Promise.race([ended, sleep(3000)]);
        if (outcome === null) { child.kill('SIGKILL'); await ended; }
      }
      writeFileSync(join(output, 'main-launch.stdout.txt'), stdout);
      writeFileSync(join(output, 'main-launch.stderr.txt'), stderr);
      report.launch = { attempted: true, method: 'Direct executable spawn without quarantine; no LaunchServices or Gatekeeper approval was simulated',
        remainedRunningForObservation: remainedRunning, observationSeconds, terminationRequestedByDiagnostic: remainedRunning,
        outcome, stdout, stderr };
    }
    report.completed = true;
  } catch (error) {
    report.diagnosticError = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (mounted && workspace) recordCommand('detach-dmg', '/usr/bin/hdiutil', ['detach', join(workspace, 'mounted')]);
    report.findings = {
      downloadSha256Verified: report.download?.digestMatches ?? null,
      dmgIntegrityVerified: report.dmg?.verify.status === 0,
      appDeepStrictSignatureValid: report.app?.copiedBundle.verify.status === 0,
      mainStrictSignatureValid: report.app?.main.verify.status === 0,
      solverStrictSignatureValid: report.app?.solver.verify.status === 0,
      nativeSignatureFailures: report.nativeObjects?.failed.length ?? null,
      gatekeeperAccepted: report.app?.gatekeeper.status === 0,
      stapledNotarizationTicketValid: report.app?.notarizationTicket.status === 0,
      unquarantinedDirectLaunchStayedRunning: report.launch?.remainedRunningForObservation ?? null,
    };
    writeFileSync(join(output, 'diagnostic-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const summary = { completed: report.completed, source: report.source, findings: report.findings,
      keyEvidence: {
        nativeSignatureFailures: report.nativeObjects?.failed || [],
        appSignatureVerification: report.app?.copiedBundle.verify.stderr.slice(-2400) || null,
        appSignatureDescription: report.app?.copiedBundle.description.stderr.slice(-2400) || null,
        mainSignatureVerification: report.app?.main.verify.stderr.slice(-1200) || null,
        mainSignatureDescription: report.app?.main.description.stderr.slice(-1800) || null,
        gatekeeperAssessment: report.app?.gatekeeper.stderr.slice(-1600) || null,
        solverSignatureVerification: report.app?.solver.verify.stderr.slice(-1200) || null,
      }, diagnosticError: report.diagnosticError || null };
    writeFileSync(join(output, 'diagnostic-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const summaryText = JSON.stringify(summary);
    for (let offset = 0; offset < summaryText.length; offset += 1000) {
      console.log(`::notice title=macOS download diagnostics ${offset / 1000 + 1}::${workflowEscape(summaryText.slice(offset, offset + 1000))}`);
    }
    console.log(`Full read-only diagnostic report: ${join(output, 'diagnostic-report.json')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
