import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatBuildVersion, resolveBuildVersion, validateBuildVersion, workflowBuildVersion } from '../../scripts/build-version.ts'
import { prepareRelease } from '../../scripts/prepare-desktop-release.mjs'

test('build labels use Shanghai time across UTC day and year boundaries', () => {
  assert.equal(formatBuildVersion(new Date('2026-10-12T15:59:59Z')), '2026.1012.2359')
  assert.equal(formatBuildVersion(new Date('2026-10-12T16:00:00Z')), '2026.1013.0000')
  assert.equal(formatBuildVersion(new Date('2026-12-31T16:00:00Z')), '2027.0101.0000')
  assert.equal(formatBuildVersion(new Date('2028-02-28T16:00:00Z')), '2028.0229.0000')
  assert.throws(() => formatBuildVersion(new Date('invalid')), /无效日期/)
})

test('explicit build labels require real dates, leap days and valid minute precision', () => {
  for (const valid of ['2026.1012.0809', '2028.0229.2359', '2000.0229.0000']) {
    assert.equal(validateBuildVersion(valid), valid)
  }
  for (const invalid of ['', '2026.1012.0809\n', '2026.112.0809', '0000.0101.0000', '2026.0230.0800', '2026.0229.0800', '2100.0229.0800', '2026.0431.0800', '2026.0001.0800', '2026.1301.0800', '2026.0100.0800', '2026.0101.2400', '2026.0101.0060', null]) {
    assert.throws(() => validateBuildVersion(invalid), /构建号/)
  }
})

test('a shared CI build number is unchanged by the runner clock or time zone', () => {
  const environment = { SHIFT_FLOW_BUILD_VERSION: '2026.1012.2309' }
  assert.equal(resolveBuildVersion(environment, new Date('2026-10-12T15:09:00Z')), environment.SHIFT_FLOW_BUILD_VERSION)
  assert.equal(resolveBuildVersion(environment, new Date('2026-10-13T03:52:00Z')), environment.SHIFT_FLOW_BUILD_VERSION)
  assert.throws(() => resolveBuildVersion({ SHIFT_FLOW_BUILD_VERSION: '' }), /构建号/)
  assert.equal(resolveBuildVersion({}, new Date('2026-10-12T15:09:00Z')), '2026.1012.2309')
})

test('workflow output and environment receive the same validated value', context => {
  const directory = mkdtempSync(join(tmpdir(), 'shift-build-version-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = fileURLToPath(new URL('../../scripts/build-version.ts', import.meta.url))
  for (const [option, variable, key] of [['--github-output', 'GITHUB_OUTPUT', 'build_version'], ['--github-env', 'GITHUB_ENV', 'SHIFT_FLOW_BUILD_VERSION']]) {
    const file = join(directory, key)
    const result = spawnSync(process.execPath, [script, option], {
      encoding: 'utf8', env: { ...process.env, SHIFT_FLOW_BUILD_VERSION: '2026.1012.2309', [variable]: file },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(file, 'utf8'), `${key}=2026.1012.2309\n`)
  }
})

test('workflow retries derive a stable version from the matching run creation date', () => {
  const environment = { GITHUB_RUN_ID: '12345', GITHUB_SHA: 'a'.repeat(40) }
  const run = { id: 12345, head_sha: environment.GITHUB_SHA, created_at: '2026-12-31T16:00:00Z' }
  assert.equal(workflowBuildVersion(run, environment), '2027.0101.0000')
  assert.throws(() => workflowBuildVersion({ ...run, id: 12346 }, environment), /不匹配/)
  assert.throws(() => workflowBuildVersion({ ...run, head_sha: 'b'.repeat(40) }, environment), /不匹配/)
  assert.throws(() => workflowBuildVersion({ ...run, created_at: '2026-02-30T16:00:00Z' }, environment), /无效/)
  assert.throws(() => workflowBuildVersion({ ...run, created_at: '2026-12-31T16:00:00+08:00' }, environment), /UTC/)
})

test('release preparation rejects a different build number on any platform', context => {
  const root = mkdtempSync(join(tmpdir(), 'shift-release-version-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const artifacts = join(root, 'artifacts')
  mkdirSync(artifacts)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.1' }))
  const env = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '12345', GITHUB_REPOSITORY: 'example/planner', SHIFT_FLOW_BUILD_VERSION: '2026.1012.2309' }
  const save = (name, value) => writeFileSync(join(artifacts, name), JSON.stringify(value))
  const reports = []
  for (const [id, target, extension] of [['windows-x64', 'x86_64-pc-windows-msvc', 'exe'], ['macos-x64', 'x86_64-apple-darwin', 'dmg'], ['macos-arm64', 'aarch64-apple-darwin', 'dmg']]) {
    const native = { target, commit: env.GITHUB_SHA, buildVersion: env.SHIFT_FLOW_BUILD_VERSION, checkedInstalledResourceLayout: true, info: { engine: 'ortools-cp-sat', version: 'test' }, selfTest: { status: 'OPTIMAL', selfTest: true } }
    const month = { target, buildCommit: env.GITHUB_SHA, buildRun: env.GITHUB_RUN_ID, buildVersion: env.SHIFT_FLOW_BUILD_VERSION, checkedAppRuntime: true, status: 'FEASIBLE', assignmentCount: 155, shortageCount: 0, independentRuleIssues: [] }
    save(`${id}-native-validation.json`, native)
    save(`${id}-month-schedule-validation.json`, month)
    save(`${id}-solver-manifest.json`, { target, format: 'onedir', solverInfo: { version: 'test' } })
    if (extension === 'dmg') {
      save(`${id}-macos-app-audit.json`, { target_architecture: id === 'macos-arm64' ? 'arm64' : 'x86_64', validation: { passed: true, errors: [] }, summary: { all_macho_objects_contain_target_architecture: true, all_symlinks_internal_and_resolvable: true }, minimum_system_assessment: { declaration_understates_observed_minimum: false } })
      save(`${id}-macos-signature-validation.json`, { commit: env.GITHUB_SHA, buildRun: env.GITHUB_RUN_ID, passed: true, sealedResourcesVerified: true, allNativeObjectsVerified: true, checks: { pythonFramework: { strictDeepVerified: true } } })
    }
    // Minimal magic-byte fixtures exercise release metadata only, not native installation.
    const installer = Buffer.alloc(1024)
    installer.write(extension === 'exe' ? 'MZ' : 'koly', extension === 'exe' ? 0 : 512)
    writeFileSync(join(artifacts, `shift-schedule-expert-${id}.${extension}`), installer)
    reports.push({ id, native, month })
  }
  writeFileSync(join(artifacts, 'shift-planner-source.zip'), Buffer.from('504b0304', 'hex'))
  const release = prepareRelease(root, env)
  assert.equal(release.buildVersion, env.SHIFT_FLOW_BUILD_VERSION)
  assert.deepEqual(release.files.map(file => file.name).sort(), [
    'SHA256SUMS', 'shift-planner-source.zip', 'shift-schedule-expert-macos-arm64.dmg',
    'shift-schedule-expert-macos-x64.dmg', 'shift-schedule-expert-windows-x64.exe',
  ])
  const notes = readFileSync(join(root, 'desktop-release-notes.md'), 'utf8')
  assert.ok(notes.startsWith('Shift Schedule Expert 1.1.1 ·'))
  for (const file of release.files) assert.ok(notes.includes(file.name))
  for (const { id, native, month } of reports) {
    save(`${id}-native-validation.json`, { ...native, buildVersion: '2026.1012.2310' })
    assert.throws(() => prepareRelease(root, env), /different UI build number/)
    save(`${id}-native-validation.json`, native)
    save(`${id}-month-schedule-validation.json`, { ...month, buildVersion: '2026.1012.2310' })
    assert.throws(() => prepareRelease(root, env), /different month validation build number/)
    save(`${id}-month-schedule-validation.json`, month)
  }
})
