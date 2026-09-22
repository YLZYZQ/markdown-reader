'use strict';

// Actual-main recovery regression. Native prompts are controlled; disk I/O, renderer,
// window ownership and file watching use production code and isolated temporary data.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeSessionBackup, readSessionBackup, readSessionBackups } = require('../lib/session-backup');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-recovery-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
fs.writeFileSync(path.join(userData, 'preferences.json'), JSON.stringify({ autoSave: false, updateCheckEnabled: false }));
const docs = path.join(userData, 'documents');
fs.mkdirSync(docs);
const emptyDocument = path.join(docs, 'empty-recovery.md');
const otherDocument = path.join(docs, 'other-recovery.md');
const uncommittedDocument = path.join(docs, 'read-without-activation.md');
fs.writeFileSync(emptyDocument, '# Previously saved content');
fs.writeFileSync(otherDocument, '# Previously saved second document');
fs.writeFileSync(uncommittedDocument, '# Read only candidate');
const baseUrl = pathToFileURL(`${docs}${path.sep}`).href;
writeSessionBackup(userData, { filePath: emptyDocument, content: '', baseUrl, savedAt: 2 });
writeSessionBackup(userData, { filePath: otherDocument, content: '# Unsaved second document', baseUrl, savedAt: 1 }, 'second-window');

const recoveryPrompts = [];
let closePromptCount = 0;
let closeResponse = 1;
let saveDialogCount = 0;
dialog.showMessageBox = (window, options) => {
  if (options.buttons.length === 2) {
    return new Promise((resolve) => recoveryPrompts.push({ window, resolve }));
  }
  closePromptCount += 1;
  return Promise.resolve({ response: closeResponse });
};
dialog.showSaveDialog = async () => {
  saveDialogCount += 1;
  return { canceled: true };
};

const originalArgv = process.argv;
process.argv = [process.execPath];
require('../main');
process.argv = originalArgv;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await wait(50);
  }
  throw new Error(message);
}
const evaluate = (window, source) => window.webContents.executeJavaScript(source);
let finished = false;
const timeout = setTimeout(() => finish(new Error('Recovery regression timed out')), 45000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  try {
    await waitFor(() => recoveryPrompts.length === 2, 'Each backup must receive its own restore prompt');
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    assert.equal(readSessionBackups(userData).length, 2, 'Asking to restore must not consume either backup');
    for (const { window } of recoveryPrompts) {
      window.webContents.setBackgroundThrottling(false);
      const firstRead = await evaluate(window, 'window.api.takeBackup()');
      const secondRead = await evaluate(window, 'window.api.takeBackup()');
      assert.deepEqual(secondRead, firstRead, 'Repeated takeBackup must not consume a pending restore');
    }
    const restoreDirtyNotifications = [];
    const recordDirty = (event, dirty) => restoreDirtyNotifications.push({ id: event.sender.id, dirty });
    ipcMain.on('document:setDirty', recordDirty);
    closeResponse = 2; // Cancel a close specifically during the main-to-renderer handoff.
    const handoffWindow = recoveryPrompts[0].window;
    recoveryPrompts[0].resolve({ response: 0 });
    await new Promise((resolve, reject) => {
      // Resolving the native dialog queues main's await continuation first. This
      // microtask runs after main accepts recovery, before another renderer IPC
      // task can report dirty state. Closing here exercises the vulnerable gap.
      queueMicrotask(() => {
        try {
          assert.equal(restoreDirtyNotifications.length, 0, 'Renderer must not have acknowledged recovery yet');
          handoffWindow.close();
          assert.equal(closePromptCount, 1, 'Main must already protect the accepted recovery as dirty');
          assert.equal(handoffWindow.isDestroyed(), false, 'Close during handoff must remain cancellable');
          assert.equal(readSessionBackups(userData).length, 2, 'Handoff close must not erase either recovery');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    recoveryPrompts[1].resolve({ response: 0 });
    await waitFor(async () => (await Promise.all(recoveryPrompts.map(({ window }) => evaluate(window, 'isDirty')))).every(Boolean),
      'Both restored documents must be marked dirty, including empty content');
    const states = await Promise.all(recoveryPrompts.map(async ({ window }) => ({ window, filePath: await evaluate(window, 'currentFilePath') })));
    const emptyWindow = states.find((state) => state.filePath === emptyDocument)?.window;
    const otherWindow = states.find((state) => state.filePath === otherDocument)?.window;
    assert.ok(emptyWindow && otherWindow, 'Each document must restore in its own window');
    assert.equal(await evaluate(emptyWindow, 'window.editor.getMarkdown()'), '');
    assert.equal(await evaluate(otherWindow, 'window.editor.getMarkdown()'), '# Unsaved second document');
    assert.equal(readSessionBackups(userData).length, 2, 'Restoration alone must retain both records');
    await waitFor(() => states.every(({ window }) => restoreDirtyNotifications.some((entry) => entry.id === window.webContents.id && entry.dirty)),
      'Each renderer must report its restored content as dirty');
    assert.equal(restoreDirtyNotifications.every((entry) => entry.dirty === true), true,
      'Restoration must never transiently report a clean document after main has protected it');
    ipcMain.removeListener('document:setDirty', recordDirty);
    closeResponse = 1; // Subsequent explicit close discards only this window.

    assert.equal(await evaluate(emptyWindow, 'window.saveFile(false)'), true, 'Restored file must save directly to its authorized original path');
    assert.equal(saveDialogCount, 0, 'Recovery must not force Save As');
    assert.equal(fs.readFileSync(emptyDocument, 'utf8'), '', 'An intentional deletion of all content must save');
    await waitFor(() => readSessionBackup(userData) === null, 'Successful save must clear only its own recovery');
    assert.equal(readSessionBackup(userData, 'second-window').content, '# Unsaved second document');

    await evaluate(emptyWindow, 'window.editor.setMarkdown("# Edited after recovery");');
    await waitFor(() => readSessionBackup(userData)?.content === '# Edited after recovery', 'Further edits must recreate this window backup');
    emptyWindow.close();
    await waitFor(() => emptyWindow.isDestroyed(), 'Discarding a dirty window must close it');
    assert.equal(closePromptCount, 2);
    assert.equal(readSessionBackup(userData), null, 'Discard must clear its own record');
    assert.equal(otherWindow.isDestroyed(), false);
    assert.equal(readSessionBackup(userData, 'second-window').content, '# Unsaved second document', 'Discard must preserve the other window');

    const candidate = await evaluate(otherWindow, `window.api.openPath(${JSON.stringify(uncommittedDocument)})`);
    assert.equal(candidate.error, undefined, JSON.stringify(candidate));
    assert.equal(await evaluate(otherWindow, 'currentFilePath'), otherDocument);
    fs.writeFileSync(otherDocument, '# Externally changed second document with a different length');
    await waitFor(() => evaluate(otherWindow, 'document.getElementById("status-info").textContent').then((text) => text.includes('外部程序修改')),
      'Reading a candidate without activation must preserve the original watcher');

    // Event-level quit regression: bypass the 300 ms debounce, invoking the actual
    // will-quit listener synchronously. This does not simulate OS process shutdown.
    const event = { sender: otherWindow.webContents };
    ipcMain.emit('prefs:set', event, { editorFontSize: 23, theme: 'cream' });
    ipcMain.emit('document:activate', event, uncommittedDocument);
    const beforeFlush = JSON.parse(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8'));
    assert.notEqual(beforeFlush.editorFontSize, 23, 'The debounced preference must still be pending');
    app.emit('will-quit', {});
    const preferences = JSON.parse(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8'));
    assert.equal(preferences.editorFontSize, 23);
    assert.equal(preferences.theme, 'cream');
    const recent = JSON.parse(fs.readFileSync(path.join(userData, 'recent.json'), 'utf8'));
    assert.equal(recent[0].path, uncommittedDocument, 'Quit listener must flush the latest recent entry');
    console.log('Recovery regression OK: empty/legacy and multi-window recovery, durable prompts, protected restore handoff with no transient clean notification, direct save authorization, isolated cleanup, unchanged watcher on uncommitted reads, and will-quit preference/recent flush.');
    finish();
  } catch (error) { finish(error); }
}).catch(finish);
