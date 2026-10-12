import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

// Increment when the required signing layout changes, so old onedir caches
// cannot skip sealing the framework's Info.plist and resource envelope.
export const MAC_SIGNATURE_FORMAT = 1;

export function hasCurrentMacSignatureFormat(manifest, platform = process.platform) {
  return platform !== 'darwin' || (manifest.macSignatureFormat === MAC_SIGNATURE_FORMAT
    && manifest.macSignatures?.strictVerification === true);
}

function runNative(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requireCommand(execute, command, args) {
  const result = execute(command, args);
  if (result.error || result.status !== 0) {
    throw new Error(`macOS 求解器签名检查失败：${command} ${args.join(' ')}\n${result.stderr || result.stdout || result.error?.message || result.signal || result.status}`);
  }
  return (result.stdout || '').trim();
}

function isMachO(file) {
  const descriptor = openSync(file, 'r'), bytes = Buffer.alloc(4);
  try {
    return readSync(descriptor, bytes, 0, 4, 0) === 4
      && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32BE(0));
  } finally { closeSync(descriptor); }
}

/** Seal framework bundles, without re-signing unrelated native libraries.
 * This runs in staging BEFORE the frozen self-test and runtime manifest.
 * It provides an ad-hoc integrity seal, not Developer ID or notarization.
 */
export function sealMacSolverRuntime(directory, { platform = process.platform, execute = runNative } = {}) {
  if (platform !== 'darwin') return null;
  const root = realpathSync(resolve(directory)), frameworks = [], binaries = [];
  const nameOf = file => relative(root, file).replaceAll('\\', '/');
  const contained = path => {
    const real = realpathSync(path);
    assert.ok(real.startsWith(`${root}${sep}`), `Framework path or symbolic link escapes the runtime: ${path}`);
    return real;
  };
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) { contained(file); continue; }
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.framework')) frameworks.push(file);
        collect(file);
      } else if (entry.isFile() && isMachO(file)) binaries.push(file);
    }
  }
  collect(root);
  const solver = contained(join(root, 'shiftflow-solver'));
  assert.ok(binaries.includes(solver), 'The macOS solver is not a native Mach-O executable');
  // If a framework ever contains another framework, seal the inner one first.
  frameworks.sort((left, right) => right.split(sep).length - left.split(sep).length || left.localeCompare(right));
  const frameworkRecords = [];
  for (const framework of frameworks) {
    const executableName = basename(framework, '.framework');
    const executable = contained(join(framework, executableName));
    assert.ok(binaries.includes(executable), `Missing native framework executable: ${framework}`);
    const resourceInfo = join(framework, 'Resources', 'Info.plist');
    const info = contained(existsSync(resourceInfo) ? resourceInfo : join(framework, 'Info.plist'));
    const declaredExecutable = requireCommand(execute, '/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', info]);
    const packageType = requireCommand(execute, '/usr/bin/plutil', ['-extract', 'CFBundlePackageType', 'raw', '-o', '-', info]);
    assert.equal(declaredExecutable, executableName, `Unexpected CFBundleExecutable in ${info}`);
    assert.equal(packageType, 'FMWK', `Unexpected CFBundlePackageType in ${info}`);
    requireCommand(execute, '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', framework]);
    requireCommand(execute, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', framework]);
    frameworkRecords.push({ path: nameOf(framework), executable: nameOf(executable), infoPlist: nameOf(info), sealed: true });
  }
  requireCommand(execute, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', solver]);
  for (const binary of binaries) {
    if (binary === solver) continue;
    requireCommand(execute, '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary]);
  }
  return {
    identity: '-', kind: 'ad-hoc', developerIdSigned: false, notarized: false,
    strictVerification: true, frameworks: frameworkRecords,
    solver: nameOf(solver), nativeObjectCount: binaries.length,
  };
}
