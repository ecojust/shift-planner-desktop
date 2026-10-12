import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function capture(command, args) {
  const result = spawnSync(command, args, {
    shell: false, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  const report = {
    command, args, exitCode: result.status, signal: result.signal,
    stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(),
  };
  if (result.error) throw new Error(`Cannot execute signature verification: ${result.error.message}`);
  return report;
}

/** Parse codesign's own description; never infer a seal from a filename alone. */
export function parseCodeSignature(description) {
  const sealed = /^Sealed Resources version=(\d+) rules=(\d+) files=(\d+)\s*$/m.exec(description);
  const info = /^Info\.plist entries=(\d+)\s*$/m.exec(description);
  return {
    adHoc: /^Signature=adhoc\s*$/m.test(description),
    linkerSigned: /\blink(er)?-signed\b/.test(description),
    teamIdentifier: /^TeamIdentifier=(.*)$/m.exec(description)?.[1]?.trim() || null,
    authorities: [...description.matchAll(/^Authority=(.*)$/gm)].map(match => match[1].trim()),
    sealedResources: sealed ? { version: Number(sealed[1]), rules: Number(sealed[2]), files: Number(sealed[3]) } : null,
    boundInfoPlistEntries: info ? Number(info[1]) : 0,
    hardenedRuntime: /^CodeDirectory .*\bruntime\b/m.test(description),
  };
}

export function requireAdHocBundleSeal(signature, minimumResourceFiles = 1) {
  assert.equal(signature.adHoc, true, 'Expected an explicitly ad-hoc signed app');
  assert.equal(signature.linkerSigned, false, 'The linker signature is not a final application bundle signature');
  assert.ok(signature.sealedResources?.version >= 2 && signature.sealedResources.files >= minimumResourceFiles,
    'Missing sealed app resources: refusing to publish an app with only a linker signature');
  assert.ok(signature.boundInfoPlistEntries > 0, 'Info.plist is not bound to the application signature');
  assert.deepEqual(signature.authorities, [], 'Unexpected certificate identity in the ad-hoc build');
  assert.ok(!signature.teamIdentifier || signature.teamIdentifier === 'not set', 'Unexpected Apple team identity');
}

/** Read-only validation. This never signs, clears quarantine, or changes an app. */
export function verifyMacSignature(appPath) {
  assert.equal(process.platform, 'darwin', 'macOS signature verification requires a native macOS runner');
  const app = resolve(appPath);
  assert.ok(existsSync(app) && statSync(app).isDirectory() && app.endsWith('.app'), `Missing final .app: ${app}`);
  const plist = capture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents', 'Info.plist')]);
  assert.equal(plist.exitCode, 0, `Cannot read application entry point: ${plist.stderr}`);
  const name = plist.stdout;
  assert.ok(name && name !== '.' && name !== '..' && basename(name) === name, 'Invalid CFBundleExecutable');
  const targets = {
    app,
    main: join(app, 'Contents', 'MacOS', name),
    solver: join(app, 'Contents', 'Resources', 'solver-runtime', 'shiftflow-solver'),
    pythonFramework: join(app, 'Contents', 'Resources', 'solver-runtime', '_internal', 'Python.framework'),
  };
  const checks = {};
  for (const [label, target] of Object.entries(targets)) {
    assert.ok(existsSync(target), `Missing signature verification target: ${target}`);
    const verification = capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', target]);
    const description = capture('/usr/bin/codesign', ['--display', '--verbose=4', target]);
    assert.equal(verification.exitCode, 0, `${label} strict signature verification failed: ${verification.stderr || verification.stdout}`);
    assert.equal(description.exitCode, 0, `${label} signature description failed: ${description.stderr}`);
    const signature = parseCodeSignature(`${description.stdout}\n${description.stderr}`);
    assert.equal(signature.adHoc, true, `${label}: expected ad-hoc code signature`);
    checks[label] = { path: target, strictDeepVerified: true, signature, verification, description };
  }
  requireAdHocBundleSeal(checks.app.signature);
  // A minimal framework can have only its executable and Info.plist, which occupy
  // special signature slots instead of counted ordinary resource files.
  requireAdHocBundleSeal(checks.pythonFramework.signature, 0);
  // Resources can contain executable code outside the standard nested-code paths.
  // Check every real Mach-O, including the Python framework executable, explicitly.
  const nativeObjects = [];
  const magic = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  function inspectDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { inspectDirectory(file); continue; }
      if (!entry.isFile()) continue;
      const descriptor = openSync(file, 'r');
      const header = Buffer.alloc(4);
      let length;
      try { length = readSync(descriptor, header, 0, 4, 0); }
      finally { closeSync(descriptor); }
      if (length !== 4 || !magic.has(header.toString('hex'))) continue;
      const verification = capture('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', file]);
      assert.equal(verification.exitCode, 0, `Native object signature failed: ${relative(app, file)}: ${verification.stderr}`);
      nativeObjects.push({ path: relative(app, file), strictVerified: true });
    }
  }
  inspectDirectory(app);
  assert.ok(nativeObjects.length >= 3, 'Missing bundled native code');
  return {
    generatedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA || null,
    buildRun: process.env.GITHUB_RUN_ID || null, app, passed: true,
    adHocSigned: true, sealedResourcesVerified: true, developerIdSigned: false, notarized: false,
    checks, nativeObjects, allNativeObjectsVerified: true,
    limitations: [
      'Ad-hoc signing verifies application integrity, not a trusted Apple developer identity or notarization.',
      'macOS can still require the user to approve this app in Privacy & Security; Gatekeeper acceptance is not asserted.',
      'These checks do not exercise the GUI or change quarantine attributes.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-macos-signature.mjs /path/to/Final.app');
    console.log(JSON.stringify(verifyMacSignature(process.argv[2]), null, 2));
  } catch (error) {
    console.error(`macOS signature validation failed: ${error.stack || error}`);
    process.exitCode = 1;
  }
}
