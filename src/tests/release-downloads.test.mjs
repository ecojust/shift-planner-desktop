import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../../scripts/maintain-release-downloads.mjs', import.meta.url).href
const modern = ['shift-schedule-expert-macos-arm64.dmg', 'shift-schedule-expert-macos-x64.dmg', 'shift-schedule-expert-windows-x64.exe']
const legacy = modern.map(name => name.replace('shift-schedule-expert-', 'shift-flow-'))

function prepare(context, installerNames) {
  const directory = mkdtempSync(join(tmpdir(), 'shift-release-downloads-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const release = {
    draft: false,
    assets: [...installerNames, 'shift-planner-source.zip'].map((name, index) => ({
      id: index + 1, name, digest: `sha256:${'a'.repeat(64)}`,
    })),
  }
  writeFileSync(join(directory, 'fixture-release.json'), JSON.stringify(release))
  // Replace only the GitHub command in this subprocess; no network or release mutation is possible.
  const runner = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { readFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.execFileSync = (command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['api', 'repos/example/planner/releases/tags/desktop-v1.3.5-12345']);
      return readFileSync('fixture-release.json', 'utf8');
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(script)}, 'prepare'];
    await import(${JSON.stringify(script)});
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'example/planner', RELEASE_TAG: 'desktop-v1.3.5-12345' },
  })
  return { result, directory, release }
}

test('release maintenance preserves current and historical installer filenames', context => {
  for (const names of [modern, legacy, [modern[0], legacy[1], modern[2]]]) {
    const { result, directory, release } = prepare(context, names)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'release-diagnostics-backup/release-before.json'), 'utf8')), release)
    const checksums = readFileSync(join(directory, 'release-diagnostics-backup/all-original-attachments-SHA256SUMS'), 'utf8')
    for (const name of names) assert.ok(checksums.includes(`  ${name}\n`))
  }
})

test('release maintenance rejects ambiguous, missing or unexpected installers before snapshotting', context => {
  for (const names of [[...modern, legacy[0]], modern.slice(1), [...modern, 'unrecognized-installer.exe']]) {
    const { result, directory } = prepare(context, names)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Expected exactly one installer|Unexpected attachment/)
    assert.equal(existsSync(join(directory, 'release-diagnostics-backup/release-before.json')), false)
  }
})
