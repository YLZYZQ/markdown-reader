'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RELEASE_API_URL,
  RELEASES_PAGE_URL,
  UpdateCheckError,
  compareVersions,
  extractLatestRelease,
  fetchLatestRelease,
  isNewerVersion,
  normalizeReleaseNotes,
  parseVersion,
} = require('../lib/update-checker');

test('parseVersion accepts release tags and rejects malformed values', () => {
  assert.deepEqual(parseVersion('v1.5.8'), [1, 5, 8]);
  assert.deepEqual(parseVersion('2.0.10'), [2, 0, 10]);
  assert.deepEqual(parseVersion('release-1.10.2'), [1, 10, 2]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(null), null);
});

test('version comparison is numeric at every segment', () => {
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('v1.5.8', '1.5.8'), 0);
  assert.equal(compareVersions('2.0.0', 'v1.99.99'), 1);
  assert.equal(isNewerVersion('v1.5.8', '1.5.7'), true);
  assert.equal(isNewerVersion('v1.5.7', '1.5.8'), false);
});

test('extractLatestRelease normalizes GitHub payload and release notes', () => {
  const release = extractLatestRelease({
    tag_name: 'v1.5.8',
    name: 'Markdown阅读器 1.5.8',
    body: '修复帮助页滚动。\r\n\r\n\r\n优化单列说明。  \n',
    draft: false,
    prerelease: false
  });
  assert.equal(release.version, '1.5.8');
  assert.equal(release.name, 'Markdown阅读器 1.5.8');
  assert.equal(release.notes, '修复帮助页滚动。\n\n优化单列说明。');
  assert.equal(release.releasesUrl, RELEASES_PAGE_URL);
  assert.equal(normalizeReleaseNotes('x'.repeat(700)).length, 600);
});

test('extractLatestRelease rejects invalid or unstable payloads', () => {
  assert.throws(() => extractLatestRelease(null), UpdateCheckError);
  assert.throws(() => extractLatestRelease({ tag_name: 'latest' }), UpdateCheckError);
  assert.throws(() => extractLatestRelease({ tag_name: 'v1.5.8', prerelease: true }), UpdateCheckError);
});

test('fetchLatestRelease sends GitHub API headers and parses stable release', async () => {
  let requested;
  const release = await fetchLatestRelease({
    currentVersion: '1.5.7',
    fetchImpl: async (url, init) => {
      requested = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v1.5.8', name: 'v1.5.8', body: '更新说明' })
      };
    }
  });
  assert.equal(requested.url, RELEASE_API_URL);
  assert.equal(requested.init.headers.Accept, 'application/vnd.github+json');
  assert.equal(requested.init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(release.version, '1.5.8');
});

test('fetchLatestRelease reports HTTP and JSON failures', async () => {
  await assert.rejects(
    () => fetchLatestRelease({
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) })
    }),
    (error) => error instanceof UpdateCheckError && error.status === 403 && /403/.test(error.message)
  );
  await assert.rejects(
    () => fetchLatestRelease({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })
    }),
    /有效 JSON/
  );
});
