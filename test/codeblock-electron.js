'use strict';

// 代码块开关回归测试：工具栏"代码块"按钮与右键菜单在光标处于
// 代码块内时执行"取消"（转回普通段落、内容保留、单步撤销），
// 块外仍为插入；Esc 从代码块跳出（文末自动补空段）；
// 源码模式同样支持围栏取消。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-codeblock-')));
app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('backup:take', () => null);
ipcMain.handle('recent:get', () => []);
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('directory:listForDocument', () => ({ rootPath: 'C:\\t', rootName: 't', entries: [], truncated: false }));

const errors = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Code block toggle test timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 760,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, offscreen: true
    }
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !/TextSelection endpoint/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(400);
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const clickCodeBlockButton = async () => {
    const clicked = await run(() => {
      const button = document.querySelector('.toastui-editor-toolbar-icons.codeblock');
      if (!button) return false;
      button.click();
      return true;
    });
    assert.ok(clicked, 'codeblock toolbar button exists');
  };
  const md = () => run(() => window.editor.getMarkdown());

  // —— 所见即所得：插入 ⇄ 取消 ——
  await run(() => { window.editor.setMarkdown('段落一', false); window.editor.focus(); });
  await wait(200);
  await clickCodeBlockButton();
  await wait(250);
  const fenced = await md();
  assert.ok(fenced.includes('```'), `insert code block: ${JSON.stringify(fenced)}`);

  // 光标放进代码块（整篇即块，文本位 1..4，取中点 2）。
  // 等待超过 PM 历史的合并窗口（500ms），保证"取消"独立成撤销步。
  await wait(800);
  await run(() => { window.editor.setSelection(2, 2); window.editor.focus(); });
  await wait(150);
  await clickCodeBlockButton();
  await wait(250);
  const unwrapped = await md();
  assert.equal(unwrapped.trim(), '段落一', `toggle off should keep content: ${JSON.stringify(unwrapped)}`);
  const stillPre = await run(() => Boolean(document.querySelector('.toastui-editor-ww-container .ProseMirror pre')));
  assert.equal(stillPre, false, 'pre element should be gone after toggle off');

  // 单步撤销恢复代码块
  await run(() => window.editor.exec('undo'));
  await wait(200);
  const undone = await md();
  assert.ok(undone.includes('```'), `undo restores fenced block: ${JSON.stringify(undone)}`);
  await run(() => window.editor.exec('redo'));
  await wait(150);

  // 多行代码块取消：各行保留为段落
  await run(() => { window.editor.setMarkdown('第一行\n\n```\nalpha\nbeta\n```', false); window.editor.focus(); });
  await wait(250);
  await run(() => { window.editor.setSelection(7, 7); window.editor.focus(); });
  await wait(150);
  await clickCodeBlockButton();
  await wait(250);
  const multi = await md();
  assert.ok(multi.includes('alpha') && multi.includes('beta') && !multi.includes('```'),
    `multi-line unwrap keeps lines: ${JSON.stringify(multi)}`);

  // —— Esc：跳出代码块（文末自动补空段） ——
  await run(() => { window.editor.setMarkdown('前文\n\n```\ncode\n```', false); window.editor.focus(); });
  await wait(250);
  await run(() => { window.editor.setSelection(6, 6); window.editor.focus(); });
  await wait(150);
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(250);
  const afterEsc = await run(() => ({
    md: window.editor.getMarkdown(),
    inBlock: (function () {
      const sel = window.getSelection();
      if (!sel || !sel.anchorNode) return false;
      return Boolean(sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('pre'));
    })(),
    tail: window.editor.getMarkdown().slice(-8)
  }));
  assert.equal(afterEsc.inBlock, false, `Esc should move caret out of the block: ${JSON.stringify(afterEsc)}`);
  assert.ok(/```\s*$/.test(afterEsc.md), `trailing paragraph added after block at doc end: ${JSON.stringify(afterEsc)}`);

  // —— 源码模式：围栏取消 ——
  await run(() => window.editor.changeMode('markdown'));
  await wait(300);
  await run(() => { window.editor.setMarkdown('开头\n\n```\ninside\n```\n\n结尾', false); });
  await wait(250);
  await run(() => { window.editor.setSelection([4, 2], [4, 2]); window.editor.focus(); });
  await wait(150);
  await clickCodeBlockButton();
  await wait(250);
  const mdAfter = await md();
  assert.ok(!mdAfter.includes('```'), `source-mode fences removed: ${JSON.stringify(mdAfter)}`);
  assert.ok(mdAfter.includes('inside') && mdAfter.includes('开头') && mdAfter.includes('结尾'),
    `source-mode content preserved: ${JSON.stringify(mdAfter)}`);
  // 行未粘连、未吞行
  const lineCount = mdAfter.split('\n').filter((line) => line.trim() !== '').length;
  assert.ok(lineCount >= 3, `source-mode lines preserved: ${JSON.stringify(mdAfter)}`);

  await win.destroy();
  if (errors.length) { console.error('console errors:', errors); app.exit(1); return; }
  clearTimeout(timeout);
  console.log('codeblock-electron: all assertions passed');
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
