'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createDocumentWatcher, CHANGE_DEBOUNCE_MS } = require('../lib/doc-watcher');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let count = 0; count < 12; count++) await Promise.resolve();
}

function mockWatcher(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const handles = [];
  const changes = [];
  const watcher = createDocumentWatcher({
    onExternalChange: (kind) => changes.push(kind),
    stat(filePath) {
      const request = { filePath, ...deferred() };
      requests.push(request);
      return request.promise;
    },
    watchDir(_directory, callback) {
      const handle = new EventEmitter();
      handle.closed = false;
      handle.close = () => { handle.closed = true; };
      handle.change = (name) => callback('change', name);
      handles.push(handle);
      return handle;
    }
  });
  t.after(() => watcher.stop());
  async function changed(handle = handles.at(-1)) {
    handle.change();
    t.mock.timers.tick(CHANGE_DEBOUNCE_MS);
    await flushPromises();
  }
  return { watcher, requests, handles, changes, changed };
}

test('a same-size external edit immediately after an own save is still reported', async (t) => {
  const { watcher, requests, changes, changed } = mockWatcher(t);
  watcher.watch('doc.md');
  requests[0].resolve({ mtimeMs: 1, size: 10 });
  await flushPromises();
  const saved = watcher.markOwnWrite('doc.md');
  await flushPromises();
  requests[1].resolve({ mtimeMs: 2, size: 10 });
  await saved;
  await changed();
  requests[2].resolve({ mtimeMs: 3, size: 10 });
  await flushPromises();
  assert.deepEqual(changes, ['modified']);
  await changed();
  requests[3].resolve({ mtimeMs: 3, size: 10 });
  await flushPromises();
  assert.deepEqual(changes, ['modified'], 'duplicate directory events are ignored');
});

for (const action of ['stop', 'switch']) {
  test(`in-flight inspection cannot notify or overwrite a baseline after ${action}`, async (t) => {
    const { watcher, requests, handles, changes, changed } = mockWatcher(t);
    watcher.watch('a.md');
    requests[0].resolve({ mtimeMs: 1, size: 10 });
    await flushPromises();
    await changed();
    if (action === 'switch') {
      watcher.watch('b.md');
      requests[2].resolve({ mtimeMs: 20, size: 20 });
      await flushPromises();
    } else watcher.stop();
    requests[1].resolve({ mtimeMs: 2, size: 11 });
    await flushPromises();
    await changed(handles[0]);
    assert.equal(requests.length, action === 'switch' ? 3 : 2, 'closed watcher callbacks stay inactive');
    if (action === 'switch') {
      await changed();
      requests[3].resolve({ mtimeMs: 20, size: 20 });
      await flushPromises();
    }
    assert.deepEqual(changes, []);
  });
}

test('a late initial stat cannot replace the new document baseline', async (t) => {
  const { watcher, requests, changes, changed } = mockWatcher(t);
  watcher.watch('a.md');
  watcher.watch('b.md');
  requests[1].resolve({ mtimeMs: 20, size: 20 });
  await flushPromises();
  requests[0].resolve({ mtimeMs: 1, size: 10 });
  await flushPromises();
  await changed();
  requests[2].resolve({ mtimeMs: 20, size: 20 });
  await flushPromises();
  assert.deepEqual(changes, []);
});

test('initial stat cannot overwrite a newer own-save baseline', async (t) => {
  const { watcher, requests, changes, changed } = mockWatcher(t);
  watcher.watch('doc.md');
  const saved = watcher.markOwnWrite('doc.md');
  await flushPromises();
  requests[1].resolve({ mtimeMs: 2, size: 10 });
  await saved;
  requests[0].resolve({ mtimeMs: 1, size: 10 });
  await flushPromises();
  await changed();
  requests[2].resolve({ mtimeMs: 2, size: 10 });
  await flushPromises();
  assert.deepEqual(changes, []);
});

test('a late own-save stat cannot replace the new document baseline', async (t) => {
  const { watcher, requests, changes, changed } = mockWatcher(t);
  watcher.watch('a.md');
  requests[0].resolve({ mtimeMs: 1, size: 10 });
  await flushPromises();
  const saved = watcher.markOwnWrite('a.md');
  await flushPromises();
  watcher.watch('b.md');
  requests[2].resolve({ mtimeMs: 20, size: 20 });
  await flushPromises();
  requests[1].resolve({ mtimeMs: 2, size: 11 });
  await saved;
  await changed();
  requests[3].resolve({ mtimeMs: 20, size: 20 });
  await flushPromises();
  assert.deepEqual(changes, []);
});

test('directory events wait for an in-flight own-save baseline', async (t) => {
  const { watcher, requests, changes, changed } = mockWatcher(t);
  watcher.watch('doc.md');
  requests[0].resolve({ mtimeMs: 1, size: 10 });
  await flushPromises();
  const saved = watcher.markOwnWrite('doc.md');
  await flushPromises();
  await changed();
  assert.equal(requests.length, 2, 'inspection must wait for the own-save stat');
  requests[1].resolve({ mtimeMs: 2, size: 11 });
  await saved;
  await flushPromises();
  requests[2].resolve({ mtimeMs: 2, size: 11 });
  await flushPromises();
  assert.deepEqual(changes, []);
});

test('an inspection started before own-save recording cannot undo its baseline', async (t) => {
  const { watcher, requests, changes, changed } = mockWatcher(t);
  watcher.watch('doc.md');
  requests[0].resolve({ mtimeMs: 1, size: 10 });
  await flushPromises();
  await changed();
  const saved = watcher.markOwnWrite('doc.md');
  await flushPromises();
  requests[2].resolve({ mtimeMs: 3, size: 30 });
  await saved;
  requests[1].resolve({ mtimeMs: 2, size: 20 });
  await flushPromises();
  await changed();
  requests[3].resolve({ mtimeMs: 3, size: 30 });
  await flushPromises();
  assert.deepEqual(changes, []);
});

test('out-of-order inspections keep the most recent file state', async (t) => {
  const { watcher, requests, changes, changed } = mockWatcher(t);
  watcher.watch('doc.md');
  requests[0].resolve({ mtimeMs: 1, size: 10 });
  await flushPromises();
  await changed();
  await changed();
  requests[2].resolve({ mtimeMs: 3, size: 30 });
  await flushPromises();
  requests[1].resolve({ mtimeMs: 2, size: 20 });
  await flushPromises();
  await changed();
  requests[3].resolve({ mtimeMs: 3, size: 30 });
  await flushPromises();
  assert.deepEqual(changes, ['modified']);
});

test('asynchronous watcher errors close the current watcher and allow retry', async (t) => {
  const { watcher, requests, handles, changes, changed } = mockWatcher(t);
  watcher.watch('doc.md');
  handles[0].emit('error', new Error('watch unavailable'));
  assert.equal(handles[0].closed, true);
  watcher.watch('doc.md');
  assert.equal(handles.length, 2);
  requests[1].resolve({ mtimeMs: 20, size: 20 });
  await flushPromises();
  requests[0].reject(new Error('stale stat failure'));
  handles[0].emit('error', new Error('late watcher error'));
  await flushPromises();
  assert.equal(handles[1].closed, false);
  await changed();
  requests[2].resolve({ mtimeMs: 20, size: 20 });
  await flushPromises();
  assert.deepEqual(changes, []);
});

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
