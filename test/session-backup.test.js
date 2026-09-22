'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clearSessionBackup,
  readSessionBackup,
  readSessionBackups,
  sessionBackupPath,
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

test('window backups are isolated and reading never consumes legacy or named records', () => {
  const dir = tempDir();
  const legacy = writeSessionBackup(dir, { content: '', savedAt: 10 });
  const second = writeSessionBackup(dir, { content: 'second window', savedAt: 20 }, 'window-2');
  const expected = [{ id: 'window-2', session: second }, { id: 'session', session: legacy }];
  assert.deepEqual(readSessionBackups(dir), expected);
  assert.deepEqual(readSessionBackups(dir), expected);
  assert.equal(fs.existsSync(sessionBackupPath(dir)), true);
  assert.equal(fs.existsSync(sessionBackupPath(dir, 'window-2')), true);
  clearSessionBackup(dir, 'window-2');
  assert.deepEqual(readSessionBackups(dir), [{ id: 'session', session: legacy }]);
  assert.deepEqual(readSessionBackup(dir), legacy, 'Clearing another window must preserve an empty recovery');
});

test('backup ids cannot escape the backup directory', () => {
  const dir = tempDir();
  const sentinel = path.join(dir, 'outside.json');
  fs.writeFileSync(sentinel, JSON.stringify({ content: 'must survive', savedAt: 1 }));
  for (const id of ['../outside', '..\\outside', '/outside', 'C:\\outside', '.', '']) {
    assert.throws(() => sessionBackupPath(dir, id), /Invalid backup id/);
    assert.throws(() => writeSessionBackup(dir, { content: 'overwrite' }, id), /Invalid backup id/);
    assert.equal(readSessionBackup(dir, id), null);
    clearSessionBackup(dir, id);
  }
  assert.equal(JSON.parse(fs.readFileSync(sentinel, 'utf8')).content, 'must survive');
});

test('recovery discovery ignores corrupt, invalid, temporary and unexpected files', () => {
  const dir = tempDir();
  assert.deepEqual(readSessionBackups(dir), []);
  const valid = writeSessionBackup(dir, { content: 'recover me', savedAt: 1 }, 'valid-window');
  const backupDir = path.dirname(sessionBackupPath(dir));
  fs.writeFileSync(path.join(backupDir, 'corrupt.json'), '{');
  fs.writeFileSync(path.join(backupDir, 'invalid.json'), JSON.stringify({ content: 42 }));
  fs.writeFileSync(path.join(backupDir, 'pending.json.tmp'), JSON.stringify(valid));
  fs.writeFileSync(path.join(backupDir, 'unexpected_name.json'), JSON.stringify(valid));
  fs.mkdirSync(path.join(backupDir, 'directory.json'));
  assert.deepEqual(readSessionBackups(dir), [{ id: 'valid-window', session: valid }]);
});
