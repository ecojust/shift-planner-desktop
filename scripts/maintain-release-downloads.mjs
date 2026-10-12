import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG;
assert.match(repository || '', /^[\w.-]+\/[\w.-]+$/);
assert.match(tag || '', /^desktop-v[\w.-]+-\d+$/);
const mode = process.argv[2];
assert.ok(['prepare', 'apply'].includes(mode));
const directory = 'release-diagnostics-backup';
mkdirSync(directory, { recursive: true });
const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
const api = path => JSON.parse(gh(['api', `repos/${repository}/${path}`]));
const current = api(`releases/tags/${tag}`);
assert.equal(current.draft, false);
const wanted = ['shift-flow-macos-arm64.dmg', 'shift-flow-macos-x64.dmg', 'shift-flow-windows-x64.exe', 'shift-planner-source.zip'];
const reports = current.assets.filter(asset => /^(?:macos-arm64|macos-x64|windows-x64)-(?:native-validation|month-schedule-validation|solver-manifest|macos-app-audit)\.json$/.test(asset.name));
const allowed = new Set([...wanted, 'SHA256SUMS', ...reports.map(asset => asset.name)]);
assert.ok(current.assets.every(asset => allowed.has(asset.name)), 'Unexpected attachment; leave it untouched');
for (const name of wanted) assert.equal(current.assets.filter(asset => asset.name === name).length, 1);
const assets = [...current.assets].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
for (const asset of assets) assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/);
const snapshot = join(directory, 'release-before.json');

if (mode === 'prepare') {
  assert.ok(!existsSync(snapshot));
  writeFileSync(snapshot, JSON.stringify(current, null, 2) + '\n');
  if (reports.length) {
    gh(['release', 'download', tag, '--repo', repository, '--dir', directory, '--pattern', '*.json']);
    for (const asset of reports) {
      const bytes = readFileSync(join(directory, asset.name));
      assert.equal(bytes.length, asset.size);
      assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, asset.digest);
    }
  }
  if (assets.some(asset => asset.name === 'SHA256SUMS')) {
    gh(['release', 'download', tag, '--repo', repository, '--dir', directory, '--pattern', 'SHA256SUMS']);
  }
  // Preserve a complete checksum record even if an interrupted upload removed SHA256SUMS.
  writeFileSync(join(directory, 'all-original-attachments-SHA256SUMS'), assets.filter(asset => asset.name !== 'SHA256SUMS').map(asset => `${asset.digest.slice(7)}  ${asset.name}\n`).join(''));
  console.log(`Verified backup of ${reports.length} diagnostic reports; upload this backup before apply.`);
} else {
  const before = JSON.parse(readFileSync(snapshot, 'utf8'));
  for (const field of ['id', 'tag_name', 'target_commitish', 'name', 'draft', 'prerelease', 'body']) assert.deepEqual(current[field], before[field]);
  assert.deepEqual(current.assets.map(asset => [asset.id, asset.name, asset.digest]), before.assets.map(asset => [asset.id, asset.name, asset.digest]));
  // Reports are retained in the workflow's uploaded backup before any Release mutation.
  for (const asset of reports) {
    const bytes = readFileSync(join(directory, asset.name));
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, asset.digest);
  }
  mkdirSync('release-public', { recursive: true });
  writeFileSync('release-public/SHA256SUMS', assets.filter(asset => wanted.includes(asset.name)).map(asset => `${asset.digest.slice(7)}  ${asset.name}\n`).join(''));
  gh(['release', 'upload', tag, '--repo', repository, '--clobber', 'release-public/SHA256SUMS']);
  const oldSentence = 'shift-planner-source.zip 是本次构建的精确源码；验证报告和 SHA256SUMS 一并提供。';
  const newSentence = 'shift-planner-source.zip 是本次构建的精确源码；SHA256SUMS 用于校验下载文件。JSON 验证报告保留在原构建的 Actions Artifacts（14 天），此次整理另存备份（90 天）：https://github.com/' + repository + '/actions/runs/' + process.env.GITHUB_RUN_ID;
  const body = current.body.includes(oldSentence) ? current.body.replace(oldSentence, newSentence) : current.body + '\n\n' + newSentence;
  writeFileSync('release-public/notes.md', body);
  gh(['release', 'edit', tag, '--repo', repository, '--notes-file', 'release-public/notes.md']);
  for (const asset of reports) gh(['api', '--method', 'DELETE', `repos/${repository}/releases/assets/${asset.id}`]);
  const after = api(`releases/tags/${tag}`);
  assert.deepEqual(after.assets.map(asset => asset.name).sort(), [...wanted, 'SHA256SUMS'].sort());
  for (const field of ['id', 'tag_name', 'target_commitish', 'name', 'draft', 'prerelease']) assert.deepEqual(after[field], before[field]);
  for (const name of wanted) assert.equal(after.assets.find(asset => asset.name === name).digest, before.assets.find(asset => asset.name === name).digest);
  assert.equal(after.assets.find(asset => asset.name === 'SHA256SUMS').digest, 'sha256:' + createHash('sha256').update(readFileSync('release-public/SHA256SUMS')).digest('hex'));
  console.log('::notice title=Release downloads::Five public attachments verified; installers, source and release metadata unchanged.');
}
