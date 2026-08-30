'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clearSessionBackup,
  readSessionBackup,
  writeSessionBackup,
} = require('../lib/session-backup');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-backup-test-'));
}

test('write + read roundtrip preserves the session', () => {
  const dir = tempDir();
  const session = { filePath: 'C:\\docs\\a.md', baseUrl: 'file:///C:/docs/', content: '# 内容', savedAt: 123 };
  assert.deepEqual(writeSessionBackup(dir, session), session);
  assert.deepEqual(readSessionBackup(dir), session);
});

test('read returns null when no backup exists', () => {
  assert.equal(readSessionBackup(tempDir()), null);
});

test('sessions without string content are rejected', () => {
  const dir = tempDir();
  assert.equal(writeSessionBackup(dir, { content: 42 }), null);
  assert.equal(readSessionBackup(dir), null);
});

test('corrupt backup file reads as null', () => {
  const dir = tempDir();
  const target = path.join(dir, 'backup', 'session.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{ corrupt');
  assert.equal(readSessionBackup(dir), null);
});

test('clearSessionBackup removes the file and is idempotent', () => {
  const dir = tempDir();
  writeSessionBackup(dir, { content: 'x', savedAt: 1 });
  clearSessionBackup(dir);
  assert.equal(readSessionBackup(dir), null);
  assert.doesNotThrow(() => clearSessionBackup(dir));
});

test('overwrite replaces the previous session', () => {
  const dir = tempDir();
  writeSessionBackup(dir, { content: '旧', savedAt: 1 });
  writeSessionBackup(dir, { content: '新', savedAt: 2 });
  assert.equal(readSessionBackup(dir).content, '新');
});
