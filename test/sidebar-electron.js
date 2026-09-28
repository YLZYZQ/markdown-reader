'use strict';

// 侧栏回归（最终模型）：
// - 从树根之外打开文件 → 树根锚定为文件所在目录的上一级；
// - 打开树根之内的文件 → 树根保持不变（浏览时地面不晃动）；
// - 点击文件夹行进入子目录，返回箭头始终可用且可逐级回退到盘符根；
// - 文件页签切回后大纲面板必须真正隐藏。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listDirectoryTree } = require('../lib/file-tree');

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
  content: '# 文档',
  baseUrl: `file:///${filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '')}/`
}));
ipcMain.handle('directory:listForDocument', (_event, dirPath) => listDirectoryTree(dirPath));

// base/工作区/{当前.md, 子目录/{嵌套.md, 更深目录/深层.md}} + base2/其他/{外部.md}
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-sidebar-base-'));
const workspace = path.join(base, '工作区');
const folder = path.join(workspace, '子目录');
const nestedFolder = path.join(folder, '更深目录');
fs.mkdirSync(nestedFolder, { recursive: true });
fs.writeFileSync(path.join(workspace, '当前.md'), '# 当前文档', 'utf8');
fs.writeFileSync(path.join(folder, '嵌套.md'), '# 嵌套', 'utf8');
fs.writeFileSync(path.join(nestedFolder, '深层.md'), '# 深层', 'utf8');
const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-sidebar-out-'));
const outsideFolder = path.join(base2, '其他');
fs.mkdirSync(outsideFolder);
fs.writeFileSync(path.join(outsideFolder, '外部.md'), '# 外部', 'utf8');

const norm = (p) => p.replace(/\\/g, '/');
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
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  const openDoc = async (filePath) => {
    await win.webContents.executeJavaScript(`(async () => {
      const result = await window.api.openPath(${JSON.stringify(filePath)});
      window.loadContent(result.filePath, result.content, result.baseUrl);
      await new Promise((resolve) => setTimeout(resolve, 500));
    })()`);
  };
  const state = () => run(() => ({
    root: document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/'),
    upHidden: document.getElementById('btn-tree-up').hidden,
    active: (document.querySelector('.tree-file.active .tree-name') || {}).textContent || null,
    directoryOpen: (document.querySelector('#file-tree > .tree-directory') || {}).open === true
  }));

  // 1) 首次打开 工作区/当前.md → 锚定 base（上一级），箭头可用
  await openDoc(path.join(workspace, '当前.md'));
  const anchored = await state();
  assert.equal(anchored.root, norm(base), JSON.stringify(anchored));
  assert.equal(anchored.upHidden, false, JSON.stringify(anchored));

  // 2) 打开树根之内的 子目录/嵌套.md → 树根保持 base，子目录自动展开
  await openDoc(path.join(folder, '嵌套.md'));
  const insideOpen = await state();
  assert.equal(insideOpen.root, norm(base), JSON.stringify(insideOpen));
  assert.equal(insideOpen.active, '嵌套.md', JSON.stringify(insideOpen));
  assert.equal(insideOpen.directoryOpen, true, JSON.stringify(insideOpen));

  // 3) 点击文件夹行进入 工作区 → 树根=工作区，箭头仍可用
  const entered = await run(async () => {
    document.querySelector('#file-tree > .tree-directory > summary .tree-name')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      root: document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/'),
      upHidden: document.getElementById('btn-tree-up').hidden,
      files: [...document.querySelectorAll('#file-tree > .tree-file > .tree-name')].map((el) => el.textContent)
    };
  });
  assert.equal(entered.root, norm(workspace), JSON.stringify(entered));
  assert.equal(entered.upHidden, false, JSON.stringify(entered));
  assert.ok(entered.files.includes('当前.md'), JSON.stringify(entered));

  // 3b) 继续点击 子目录 行进入更深一级 → 树根=子目录，深层文件可见
  const enteredDeep = await run(async () => {
    document.querySelector('#file-tree > .tree-directory > summary .tree-name')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      root: document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/'),
      upHidden: document.getElementById('btn-tree-up').hidden,
      files: [...document.querySelectorAll('#file-tree > .tree-file > .tree-name')].map((el) => el.textContent)
    };
  });
  assert.equal(enteredDeep.root, norm(folder), JSON.stringify(enteredDeep));
  assert.equal(enteredDeep.upHidden, false, JSON.stringify(enteredDeep));
  assert.ok(enteredDeep.files.includes('嵌套.md'), JSON.stringify(enteredDeep));

  // 4) 返回箭头逐级回退：子目录 → 工作区 → base（无上限，任何深度都能退）
  const upOnce = await run(async () => {
    document.getElementById('btn-tree-up').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      root: document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/'),
      upHidden: document.getElementById('btn-tree-up').hidden
    };
  });
  assert.equal(upOnce.root, norm(workspace), JSON.stringify(upOnce));
  assert.equal(upOnce.upHidden, false, JSON.stringify(upOnce));

  const upTwice = await run(async () => {
    document.getElementById('btn-tree-up').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/');
  });
  assert.equal(upTwice, norm(base), JSON.stringify(upTwice));

  // 5) 打开树根之外的 外部.md → 重新锚定为其目录上一级 base2
  await openDoc(path.join(outsideFolder, '外部.md'));
  const reanchored = await state();
  assert.equal(reanchored.root, norm(base2), JSON.stringify(reanchored));
  assert.equal(reanchored.active, '外部.md', JSON.stringify(reanchored));

  // 6) 大纲页签切换后文件树恢复且大纲真正隐藏
  const outlineHidden = await run(async () => {
    window.editor.setMarkdown('# 大纲标题', false);
    document.getElementById('tab-outline').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    document.getElementById('tab-files').click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const outline = document.getElementById('outline-panel');
    const files = document.getElementById('file-tree');
    return {
      outlineHidden: outline.hidden,
      outlineDisplay: getComputedStyle(outline).display,
      filesHidden: files.hidden,
      root: document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/')
    };
  });
  assert.deepEqual({
    outlineHidden: outlineHidden.outlineHidden,
    outlineDisplay: outlineHidden.outlineDisplay,
    filesHidden: outlineHidden.filesHidden,
    root: outlineHidden.root
  }, {
    outlineHidden: true,
    outlineDisplay: 'none',
    filesHidden: false,
    root: norm(base2)
  }, JSON.stringify(outlineHidden));

  assert.deepEqual(errors, []);
  clearTimeout(timeout);
  console.log('Sidebar regression OK: parent anchoring, stable in-root browsing, enter/up navigation without ceilings.');
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
