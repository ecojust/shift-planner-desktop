import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Only the release job runs this after all native jobs succeed.
const repository = process.env.GITHUB_REPOSITORY;
assert.match(repository || '', /^[\w.-]+\/[\w.-]+$/);
const manifest = JSON.parse(readFileSync('desktop-release-manifest.json', 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.commit, process.env.GITHUB_SHA);
assert.equal(manifest.runId, process.env.GITHUB_RUN_ID);
assert.match(manifest.tag, /^desktop-v[0-9A-Za-z.-]+-\d+$/);
for (const file of manifest.files) {
  assert.match(file.name, /^[0-9A-Za-z._-]+$/);
  const bytes = readFileSync(join('artifacts', file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}
const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = args => JSON.parse(gh(args));
const missing = error => /HTTP 404|release not found/i.test(String(error.stderr || error.message));
const tagPath = `repos/${repository}/git/ref/tags/${manifest.tag}`;
let existingTag;
try { existingTag = json(['api', tagPath]); }
catch (error) { if (!missing(error)) throw error; }
if (existingTag) {
  const target = json(['api', `repos/${repository}/commits/${manifest.tag}`]);
  assert.equal(target.sha, manifest.commit, 'Existing tag points to different source');
} else {
  // Create an exact lightweight tag before any release can become public.
  gh(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${manifest.tag}`, '-f', `sha=${manifest.commit}`]);
}

const view = () => json(['release', 'view', manifest.tag, '--repo', repository, '--json', 'apiUrl,isDraft,isPrerelease,targetCommitish,url,assets']);
let release;
try { release = view(); }
catch (error) { if (!missing(error)) throw error; }
if (release) {
  assert.equal(release.targetCommitish, manifest.commit);
  assert.equal(release.isPrerelease, true, 'Refusing to change an existing stable release');
} else {
  gh(['release', 'create', manifest.tag, '--repo', repository, '--target', manifest.commit,
    '--verify-tag', '--draft', '--prerelease', '--title', `Shift Schedule Expert ${manifest.version} · Windows / Intel Mac / M 芯片`,
    '--notes-file', 'desktop-release-notes.md', ...manifest.files.map(file => join('artifacts', file.name))]);
}
release = view();
assert.equal(release.targetCommitish, manifest.commit);
assert.equal(release.isPrerelease, true);
// gh's "id" is a GraphQL node ID, not the numeric REST ID; apiUrl is stable across CLI versions.
const releaseApi = new URL(release.apiUrl);
const expectedPrefix = `/repos/${repository}/releases/`;
assert.equal(releaseApi.origin, 'https://api.github.com');
assert.ok(releaseApi.pathname.startsWith(expectedPrefix));
assert.match(releaseApi.pathname.slice(expectedPrefix.length), /^\d+$/);
const remote = json(['api', releaseApi.pathname.slice(1)]);
for (const file of manifest.files) {
  const matches = remote.assets.filter(asset => asset.name === file.name);
  assert.equal(matches.length, 1, `Incomplete release: ${file.name}; refusing publication`);
  const asset = matches[0];
  assert.equal(asset.state, 'uploaded');
  assert.equal(asset.size, file.bytes, `Attachment size differs: ${file.name}`);
  if (asset.digest) {
    assert.equal(asset.digest, `sha256:${file.sha256}`, `Attachment digest differs: ${file.name}`);
  } else {
    const bytes = execFileSync('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream', '--allow-escape-sequences'],
      { timeout: 300_000, maxBuffer: Math.max(1024 * 1024, file.bytes + 1024), stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Attachment digest differs: ${file.name}`);
  }
}
// Do not overwrite an earlier run's files. Incomplete uploads remain an unpublished draft.
assert.equal(json(['api', `repos/${repository}/commits/${manifest.tag}`]).sha, manifest.commit);
if (release.isDraft) gh(['release', 'edit', manifest.tag, '--repo', repository, '--draft=false']);
const actual = json(['api', `repos/${repository}/commits/${manifest.tag}`]);
assert.equal(actual.sha, manifest.commit);
release = view();
assert.equal(release.isDraft, false);
console.log(JSON.stringify({ url: release.url, tag: manifest.tag, files: release.assets.map(asset => asset.name) }, null, 2));
