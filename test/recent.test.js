'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_RECENT_ENTRIES,
  addRecentEntry,
  loadRecent,
  saveRecent,
} = require('../lib/recent');

test('addRecentEntry puts newest first and dedupes case-insensitively', () => {
  let entries = addRecentEntry([], 'C:\\Docs\\a.md', 1);
  entries = addRecentEntry(entries, 'C:\\Docs\\b.md', 2);
  entries = addRecentEntry(entries, 'c:\\docs\\A.MD', 3);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'c:\\docs\\A.MD');
  assert.equal(entries[0].openedAt, 3);
  assert.equal(entries[1].path, 'C:\\Docs\\b.md');
});

test('addRecentEntry caps at the maximum size', () => {
  let entries = [];
  for (let i = 0; i < 15; i += 1) entries = addRecentEntry(entries, `C:\\d\\f${i}.md`, i);
  assert.equal(entries.length, MAX_RECENT_ENTRIES);
  assert.equal(entries[0].path, 'C:\\d\\f14.md');
});

test('addRecentEntry ignores empty paths', () => {
  assert.deepEqual(addRecentEntry([], ''), []);
  assert.deepEqual(addRecentEntry(null, 'C:\\a.md', 1).length, 1);
});

test('loadRecent tolerates missing, corrupt and malformed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-test-'));
  assert.deepEqual(loadRecent(path.join(dir, 'missing.json')), []);
  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ nope');
  assert.deepEqual(loadRecent(corrupt), []);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify([{ nope: 1 }, 'x', { path: '  ' }, { path: 'C:\\ok.md', openedAt: 'NaN' }]));
  assert.deepEqual(loadRecent(bad), [{ path: 'C:\\ok.md', openedAt: 0 }]);
});

test('saveRecent + loadRecent roundtrip', () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recent-test-')), 'recent.json');
  saveRecent(filePath, [{ path: 'C:\\a.md', openedAt: 5 }, { path: 'C:\\b.md', openedAt: 6 }]);
  assert.deepEqual(loadRecent(filePath), [
    { path: 'C:\\a.md', openedAt: 5 },
    { path: 'C:\\b.md', openedAt: 6 },
  ]);
});
