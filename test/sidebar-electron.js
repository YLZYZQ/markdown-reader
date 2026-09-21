'use strict';

// 侧栏回归：文件夹名进入子目录、箭头只展开/折叠、返回上一级；
// 文件页签切回后大纲面板必须真正隐藏。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listDirectoryTree, listDocumentTree } = require('../lib/file-tree');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-sidebar-')));
app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('backup:take', () => null);
ipcMain.handle('recent:get', () => []);
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('file:openPath', (_event, filePath) => ({
  filePath,
  content: '# 当前文档',
  baseUrl: `file:///${filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '')}/`
}));
ipcMain.handle('directory:listForDocument', (_event, filePath) => (
  fs.statSync(filePath).isDirectory() ? listDirectoryTree(filePath) : listDocumentTree(filePath)
));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-sidebar-docs-'));
const folder = path.join(root, '子目录');
const nestedFolder = path.join(folder, '更深目录');
fs.mkdirSync(nestedFolder, { recursive: true });
const currentPath = path.join(root, '当前.md');
fs.writeFileSync(currentPath, '# 当前文档', 'utf8');
fs.writeFileSync(path.join(folder, '嵌套.md'), '# 嵌套', 'utf8');
fs.writeFileSync(path.join(nestedFolder, '深层.md'), '# 深层', 'utf8');

const timeout = setTimeout(() => {
  console.error('Sidebar test timed out');
  app.exit(1);
}, 30000);
const errors = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: true
    }
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !/TextSelection endpoint/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(400);
  await win.webContents.executeJavaScript(`window.__testCurrentPath = ${JSON.stringify(currentPath)}`);
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  const initial = await run(async () => {
    const result = await window.api.openPath(window.__testCurrentPath);
    window.loadContent(result.filePath, result.content, result.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      root: document.getElementById('sidebar-root').textContent,
      directoryCount: document.querySelectorAll('#file-tree > .tree-directory').length,
      upHidden: document.getElementById('btn-tree-up').hidden
    };
  });
  assert.equal(initial.root, path.basename(root), JSON.stringify(initial));
  assert.equal(initial.directoryCount, 1, JSON.stringify(initial));
  assert.equal(initial.upHidden, true, JSON.stringify(initial));

  const expanded = await run(async () => {
    document.querySelector('.tree-chevron').dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true
    }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      open: document.querySelector('.tree-directory').open,
      root: document.getElementById('sidebar-root').textContent
    };
  });
  assert.equal(expanded.open, true, JSON.stringify(expanded));
  assert.equal(expanded.root, path.basename(root), JSON.stringify(expanded));

  const entered = await run(async () => {
    document.querySelector('.tree-directory .tree-name').dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true
    }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      root: document.getElementById('sidebar-root').textContent,
      upHidden: document.getElementById('btn-tree-up').hidden,
      files: [...document.querySelectorAll('#file-tree > .tree-file > .tree-name')].map((item) => item.textContent)
    };
  });
  assert.equal(entered.root, '子目录', JSON.stringify(entered));
  assert.equal(entered.upHidden, false, JSON.stringify(entered));
  assert.deepEqual(entered.files, ['嵌套.md'], JSON.stringify(entered));

  const returned = await run(async () => {
    document.getElementById('btn-tree-up').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      root: document.getElementById('sidebar-root').textContent,
      upHidden: document.getElementById('btn-tree-up').hidden,
      files: [...document.querySelectorAll('#file-tree > .tree-file > .tree-name')].map((item) => item.textContent)
    };
  });
  assert.equal(returned.root, path.basename(root), JSON.stringify(returned));
  assert.equal(returned.upHidden, true, JSON.stringify(returned));
  assert.deepEqual(returned.files, ['当前.md'], JSON.stringify(returned));

  const outlineHidden = await run(async () => {
    window.editor.setMarkdown('# 大纲标题', false);
    document.getElementById('tab-outline').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    document.getElementById('tab-files').click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const outline = document.getElementById('outline-panel');
    const files = document.getElementById('file-tree');
    return {
      outlineHidden: outline.hidden,
      outlineDisplay: getComputedStyle(outline).display,
      outlineHeight: outline.getBoundingClientRect().height,
      filesHidden: files.hidden
    };
  });
  assert.deepEqual(outlineHidden, {
    outlineHidden: true,
    outlineDisplay: 'none',
    outlineHeight: 0,
    filesHidden: false
  }, JSON.stringify(outlineHidden));
  assert.deepEqual(errors, []);
  clearTimeout(timeout);
  console.log('Sidebar regression OK: directory navigation, up navigation, and outline hiding.');
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
