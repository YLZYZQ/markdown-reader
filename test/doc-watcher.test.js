'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDocumentWatcher } = require('../lib/doc-watcher');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-watcher-test-'));
}

function tempFile(dir, name, content = 'v1\n') {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// mtime 在 Windows 上有 ~1s 精度，追加后等待刻度推进，保证 stat 可见变化。
async function tickMtime(ms = 1100) {
  await wait(ms);
}

test('notifies when the watched file is changed externally', async () => {
  const dir = tempDir();
  const filePath = tempFile(dir, 'doc.md');
  const changes = [];
  const watcher = createDocumentWatcher({ onExternalChange: (kind) => changes.push(kind) });
  watcher.watch(filePath);

  await tickMtime();
  fs.appendFileSync(filePath, 'external edit\n', 'utf8');

  const notified = await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (changes.length > 0) { clearInterval(poll); resolve(true); }
      else if (Date.now() - started > 5000) { clearInterval(poll); resolve(false); }
    }, 50);
  });
  watcher.stop();
  assert.equal(notified, true, 'should notify external change');
  assert.deepEqual(changes, ['modified']);
});

test('ignores writes recorded through markOwnWrite (app save flow)', async () => {
  const dir = tempDir();
  const filePath = tempFile(dir, 'doc.md');
  const changes = [];
  const watcher = createDocumentWatcher({ onExternalChange: (kind) => changes.push(kind) });
  watcher.watch(filePath);
  await tickMtime();

  // 模拟应用保存：先写盘，成功后记录自身写入。
  fs.appendFileSync(filePath, 'own save\n', 'utf8');
  await watcher.markOwnWrite(filePath);
  await wait(800); // 超过去抖窗口，应识别为自身写入

  watcher.stop();
  assert.equal(changes.length, 0, 'own write should not notify');
});

test('ignores directory events for other files', async () => {
  const dir = tempDir();
  const filePath = tempFile(dir, 'watched.md');
  tempFile(dir, 'other.md', 'other\n');
  const changes = [];
  const watcher = createDocumentWatcher({ onExternalChange: (kind) => changes.push(kind) });
  watcher.watch(filePath);
  await tickMtime();

  fs.appendFileSync(path.join(dir, 'other.md'), 'noise\n', 'utf8');
  await wait(700);

  watcher.stop();
  assert.equal(changes.length, 0, 'other files must not trigger');
});

test('stop() detaches the watcher', async () => {
  const dir = tempDir();
  const filePath = tempFile(dir, 'doc.md');
  const changes = [];
  const watcher = createDocumentWatcher({ onExternalChange: (kind) => changes.push(kind) });
  watcher.watch(filePath);
  await tickMtime();
  watcher.stop();

  fs.appendFileSync(filePath, 'after stop\n', 'utf8');
  await wait(700);
  assert.equal(changes.length, 0);
});

test('watching the same path twice does not restart the watcher', () => {
  const dir = tempDir();
  const filePath = tempFile(dir, 'doc.md');
  const watcher = createDocumentWatcher({ onExternalChange: () => {} });
  watcher.watch(filePath);
  assert.doesNotThrow(() => watcher.watch(filePath));
  watcher.stop();
});
