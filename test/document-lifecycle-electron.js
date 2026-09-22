'use strict';

// Exercise real renderer/editor state across deferred IPC replies. The preload
// bridge stays frozen; only the main-process file/dialog services are replaced.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');

app.commandLine.appendSwitch('disable-gpu');
const baseUrl = 'file:///C:/fixture/';
const paths = { a: 'C:\\fixture\\a.md', b: 'C:\\fixture\\b.md', c: 'C:\\fixture\\c.md' };
const calls = { reads: [], saves: [], confirms: 0, dirty: [], backups: [], activated: [], images: [] };
const readReplies = [];
const saveReplies = [];
const confirmReplies = [];
let rendererReady = false;
let finished = false;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function takeReply(queue, service) {
  assert(queue.length > 0, `Unexpected ${service} request`);
  return queue.shift();
}

ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'light', menuLanguage: 'en-US', autoSave: false, editorFontSize: 23 }));
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('backup:take', () => null);
ipcMain.handle('recent:get', () => []);
ipcMain.handle('directory:listForDocument', () => ({
  rootPath: 'C:\\fixture', rootName: 'fixture', entries: [], truncated: false
}));
ipcMain.handle('document:confirmReplace', () => {
  calls.confirms += 1;
  return takeReply(confirmReplies, 'confirmReplace');
});
ipcMain.handle('file:openPath', (_event, filePath) => {
  calls.reads.push(filePath);
  return takeReply(readReplies, 'openPath');
});
ipcMain.handle('file:open', () => {
  calls.reads.push('dialog');
  return takeReply(readReplies, 'openFile');
});
ipcMain.handle('file:save', (_event, filePath, content) => {
  calls.saves.push({ filePath, content });
  return takeReply(saveReplies, 'saveFile');
});
ipcMain.handle('image:saveBlob', (_event, filePath, fileName) => {
  calls.images.push({ filePath, fileName });
  return { markdownUrl: 'images/test.png', alt: 'test' };
});
ipcMain.on('app:rendererReady', () => { rendererReady = true; });
ipcMain.on('document:setDirty', (_event, value) => calls.dirty.push(value));
ipcMain.on('document:activate', (_event, filePath) => calls.activated.push(filePath));
ipcMain.on('backup:write', (_event, session) => calls.backups.push({ session }));
ipcMain.on('backup:clear', () => calls.backups.push({ cleared: true }));

const timeout = setTimeout(() => finish(new Error('Document lifecycle regression timed out')), 30000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false
    }
  });
  const pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (/TextSelection endpoint not pointing into a node with inline content/.test(message)) return;
    if (level >= 2 || /uncaught/i.test(message)) pageErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => finish(new Error(JSON.stringify(details))));
  win.webContents.on('did-fail-load', (_event, code, description) => finish(new Error(`${code}: ${description}`)));
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const snapshot = () => evaluate(`({
    content: editor.getMarkdown(), path: currentFilePath, dirty: isDirty,
    savedContent: lastSavedContent, transition: documentTransitionInFlight,
    saving: saveInFlight
  })`);
  const settleIpc = () => evaluate('window.api.getSystemTheme()');
  async function load(content = 'Original A') {
    await evaluate(`loadContent(${JSON.stringify(paths.a)}, ${JSON.stringify(content)}, ${JSON.stringify(baseUrl)})`);
    await settleIpc();
    const state = await snapshot();
    assert.equal(state.content, content);
    assert.equal(state.dirty, false);
  }
  async function edit(content) {
    await evaluate(`editor.setMarkdown(${JSON.stringify(content)}, false)`);
    await waitFor(async () => (await snapshot()).dirty, 'editor change event');
    await settleIpc();
  }
  async function start(name, expression) {
    await evaluate(`(() => {
      window[${JSON.stringify(name)}] = Promise.resolve(${expression});
      return true;
    })()`);
  }
  const savedReply = { filePath: paths.a, baseUrl, canceled: false };

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await waitFor(() => rendererReady, 'renderer startup');
  await waitFor(async () => evaluate('Boolean(window.editor)'), 'editor startup');

  // A save acknowledges its captured snapshot, not keystrokes made during I/O.
  await load();
  await edit('Snapshot v1');
  const delayedSave = deferred();
  saveReplies.push(delayedSave.promise);
  await start('testSave', 'saveFile(false)');
  await waitFor(() => calls.saves.length === 1, 'first save IPC');
  assert.deepEqual(calls.saves[0], { filePath: paths.a, content: 'Snapshot v1' });
  await edit('Unsaved v2');
  const clearCount = calls.backups.filter((entry) => entry.cleared).length;
  delayedSave.resolve(savedReply);
  assert.equal(await evaluate('window.testSave'), false, 'Newer edits must prevent close/replace after save');
  await settleIpc();
  let state = await snapshot();
  assert.equal(state.content, 'Unsaved v2');
  assert.equal(state.savedContent, 'Snapshot v1');
  assert.equal(state.dirty, true);
  assert.equal(calls.dirty.at(-1), true, 'Main process must still know the document is dirty');
  assert.equal(calls.backups.filter((entry) => entry.cleared).length, clearCount, 'Pending edits lost recovery backup');
  await waitFor(() => calls.backups.some((entry) => entry.session?.content === 'Unsaved v2'), 'newer-edit recovery backup');

  // A canceled dirty prompt must prevent even the file read/activation side effects.
  const readsBeforeCancel = calls.reads.length;
  const activatedBeforeCancel = calls.activated.length;
  confirmReplies.push('cancel');
  assert.equal(await evaluate(`openDocumentFromPath(${JSON.stringify(paths.b)})`), false);
  await settleIpc();
  assert.equal(calls.reads.length, readsBeforeCancel);
  assert.equal(calls.activated.length, activatedBeforeCancel);
  assert.equal((await snapshot()).content, 'Unsaved v2');

  // Main may focus an existing window and return canceled instead of a document.
  await load();
  const activationBeforeCanceledRead = calls.activated.length;
  readReplies.push({ canceled: true });
  assert.equal(await evaluate('openFile()'), false);
  await settleIpc();
  assert.equal((await snapshot()).content, 'Original A');
  assert.equal(calls.activated.length, activationBeforeCanceledRead);

  // Only one open can own a window at a time, even when reads resolve slowly.
  const readB = deferred();
  readReplies.push(readB.promise);
  const readCount = calls.reads.length;
  await start('testOpenB', `openDocumentFromPath(${JSON.stringify(paths.b)})`);
  await waitFor(() => calls.reads.length === readCount + 1, 'deferred B read');
  assert.equal(await evaluate(`openDocumentFromPath(${JSON.stringify(paths.c)})`), false);
  assert.equal(calls.reads.length, readCount + 1, 'Duplicate switch issued a second read');
  readB.resolve({ filePath: paths.b, content: 'Document B', baseUrl });
  assert.equal(await evaluate('window.testOpenB'), true);
  assert.equal((await snapshot()).path, paths.b);
  assert.equal((await snapshot()).content, 'Document B');

  // Edits made after approving replacement require another confirmation.
  await load();
  await edit('Approved for discard');
  confirmReplies.push('discard');
  const laterRead = deferred();
  readReplies.push(laterRead.promise);
  const confirmsBefore = calls.confirms;
  const readsBefore = calls.reads.length;
  await start('testLateRead', `openDocumentFromPath(${JSON.stringify(paths.b)})`);
  await waitFor(() => calls.reads.length === readsBefore + 1, 'read after initial discard approval');
  await edit('Typed while loading');
  confirmReplies.push('cancel');
  const activationBeforeLateRead = calls.activated.length;
  laterRead.resolve({ filePath: paths.b, content: 'Must not replace A', baseUrl });
  assert.equal(await evaluate('window.testLateRead'), false);
  await settleIpc();
  assert.equal(calls.confirms, confirmsBefore + 2, 'Late edits were not reconfirmed');
  assert.equal(calls.activated.length, activationBeforeLateRead);
  state = await snapshot();
  assert.equal(state.path, paths.a);
  assert.equal(state.content, 'Typed while loading');
  assert.equal(state.dirty, true);

  // File identity must remain A until its in-flight save has settled.
  await load();
  await edit('Save before switch');
  const saveBeforeSwitch = deferred();
  saveReplies.push(saveBeforeSwitch.promise);
  const savesBefore = calls.saves.length;
  await start('testSaveBeforeSwitch', 'saveFile(false)');
  await waitFor(() => calls.saves.length === savesBefore + 1, 'save before switch');
  readReplies.push({ filePath: paths.b, content: 'B after save', baseUrl });
  const readsBeforeSaveSettles = calls.reads.length;
  await start('testSwitchAfterSave', `openDocumentFromPath(${JSON.stringify(paths.b)})`);
  state = await snapshot();
  assert.equal(state.transition, true);
  assert.equal(state.saving, true);
  assert.equal(state.path, paths.a);
  assert.equal(calls.reads.length, readsBeforeSaveSettles, 'Read began before pending save completed');
  saveBeforeSwitch.resolve(savedReply);
  assert.equal(await evaluate('window.testSaveBeforeSwitch'), true);
  assert.equal(await evaluate('window.testSwitchAfterSave'), true);
  state = await snapshot();
  assert.equal(state.path, paths.b);
  assert.equal(state.content, 'B after save');
  assert.equal(state.dirty, false);
  assert.equal(state.transition, false);
  assert.equal(state.saving, false);

  // A failed automatic save keeps recovery data without recurring retries.
  await load();
  const savesBeforeFailure = calls.saves.length;
  saveReplies.push({ error: 'Injected disk write failure' });
  await evaluate('setAutoSaveEnabled(true)');
  await edit('Recover after failed auto-save');
  const clearsBeforeFailure = calls.backups.filter((entry) => entry.cleared).length;
  await waitFor(() => calls.saves.length === savesBeforeFailure + 1, 'automatic save failure');
  await waitFor(async () => !(await snapshot()).saving, 'failed save settlement');
  assert.equal((await snapshot()).dirty, true);
  assert.equal(await evaluate('autoSaveTimer === null'), true, 'Failed save scheduled another retry');
  await waitFor(() => calls.backups.some((entry) => entry.session?.content === 'Recover after failed auto-save'), 'failed-save recovery backup');
  // This observation spans one full 2-second automatic-save interval.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(calls.saves.length, savesBeforeFailure + 1, 'Automatic save kept retrying without new input');
  assert.equal(calls.backups.filter((entry) => entry.cleared).length, clearsBeforeFailure);
  assert.equal((await snapshot()).dirty, true);
  await evaluate('setAutoSaveEnabled(false)');

  // A delayed blob must not attach its image or callback to a different document.
  await load();
  await evaluate(`(() => {
    window.testImageCallbacks = [];
    const blob = {
      type: 'image/png', name: 'late.png',
      arrayBuffer: () => new Promise((resolve) => { window.resolveTestImage = resolve; })
    };
    window.testImageInsert = handleImageInsert(blob, (...args) => window.testImageCallbacks.push(args));
    return true;
  })()`);
  readReplies.push({ filePath: paths.b, content: 'B while image decodes', baseUrl });
  assert.equal(await evaluate(`openDocumentFromPath(${JSON.stringify(paths.b)})`), true);
  await evaluate('window.resolveTestImage(new ArrayBuffer(4))');
  await evaluate('window.testImageInsert');
  assert.deepEqual(calls.images, [], 'Stale image was written for the replacement document');
  assert.deepEqual(await evaluate('window.testImageCallbacks'), [], 'Stale editor image callback was invoked');
  assert.equal((await snapshot()).content, 'B while image decodes');

  // Font sizes restored from preferences may be absent from the built-in options.
  await evaluate("document.querySelector('#btn-reading-settings').click()");
  for (const language of ['zh-CN', 'en-US']) {
    await evaluate(`setApplicationLanguage(${JSON.stringify(language)})`);
    const fontState = await evaluate(`({
      language: document.documentElement.lang,
      value: document.querySelector('#font-size').value,
      label: document.querySelector('#font-size option[value="23"]').textContent,
      labels: Array.from(document.querySelectorAll('#font-size option'), (option) => option.textContent)
    })`);
    assert.equal(fontState.language, language);
    assert.equal(fontState.value, '23');
    assert.equal(fontState.label, '23 px');
    assert.equal(fontState.labels.some((label) => label.includes('undefined')), false);
  }
  assert.equal(readReplies.length + saveReplies.length + confirmReplies.length, 0, 'Unused mocked reply');
  assert.deepEqual(pageErrors, [], 'Renderer emitted errors');
  console.log('Document lifecycle: 9 deferred-IPC and state regressions passed.');
  finish();
}).catch(finish);
