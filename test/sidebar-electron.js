'use strict';

// 侧栏回归：树根固定为“当前文档所在目录的上一级”；
// 单击文件夹行展开/折叠；打开子文件夹中的文件后不会困在子文件夹；
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
  content: '# 文档',
  baseUrl: `file:///${filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '')}/`
}));
ipcMain.handle('directory:listForDocument', (_event, filePath) => (
  fs.statSync(filePath).isDirectory() ? listDirectoryTree(filePath) : listDocumentTree(filePath)
));

// 目录结构：base/工作区/{当前.md, 子目录/{嵌套.md, 更深目录/深层.md}}
// 打开 工作区 内的文件 → 树根应为 base；打开 子目录 内的文件 → 树根应为 工作区。
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-sidebar-base-'));
const workspace = path.join(base, '工作区');
const folder = path.join(workspace, '子目录');
const nestedFolder = path.join(folder, '更深目录');
fs.mkdirSync(nestedFolder, { recursive: true });
fs.writeFileSync(path.join(workspace, '当前.md'), '# 当前文档', 'utf8');
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
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const open = (filePath) => run(async (p) => {
    const result = await window.api.openPath(p);
    window.loadContent(result.filePath, result.content, result.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }).then(() => filePath ? win.webContents.executeJavaScript(`(${(() => filePath).toString()})()`) : null)
    .then(() => filePath);

  const openAndState = async (filePath) => {
    await win.webContents.executeJavaScript(`(async () => {
      const result = await window.api.openPath(${JSON.stringify(filePath)});
      window.loadContent(result.filePath, result.content, result.baseUrl);
      await new Promise((resolve) => setTimeout(resolve, 500));
    })()`);
    return run(() => ({
      root: document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/'),
      rootName: document.getElementById('sidebar-root').textContent,
      upButtonCount: document.querySelectorAll('#btn-tree-up').length,
      active: (document.querySelector('.tree-file.active .tree-name') || {}).textContent || null,
      topEntries: [...document.querySelectorAll('#file-tree > * > summary .tree-name, #file-tree > .tree-file > .tree-name')].map((el) => el.textContent)
    }));
  };

  // 打开 工作区/当前.md → 树根 = base
  const atWorkspaceFile = await openAndState(path.join(workspace, '当前.md'));
  assert.equal(atWorkspaceFile.root, base.replace(/\\/g, '/'), JSON.stringify(atWorkspaceFile));
  assert.equal(atWorkspaceFile.upButtonCount, 0, JSON.stringify(atWorkspaceFile));
  assert.ok(atWorkspaceFile.topEntries.includes('工作区'), JSON.stringify(atWorkspaceFile.topEntries));

  // 打开 子目录/嵌套.md → 树根 = 工作区，子目录自动展开，不会困在子目录
  const atSubfolderFile = await openAndState(path.join(folder, '嵌套.md'));
  assert.equal(atSubfolderFile.root, workspace.replace(/\\/g, '/'), JSON.stringify(atSubfolderFile));
  assert.equal(atSubfolderFile.active, '嵌套.md', JSON.stringify(atSubfolderFile));
  const subfolderState = await run(() => ({
    rootName: document.getElementById('sidebar-root').textContent,
    directoryOpen: document.querySelector('#file-tree > .tree-directory').open,
    files: [...document.querySelectorAll('#file-tree > .tree-directory > .tree-children > .tree-file > .tree-name')].map((el) => el.textContent)
  }));
  assert.equal(subfolderState.rootName, '工作区', JSON.stringify(subfolderState));
  assert.equal(subfolderState.directoryOpen, true, JSON.stringify(subfolderState));
  assert.ok(subfolderState.files.includes('嵌套.md'), JSON.stringify(subfolderState));

  // 单击文件夹行 → 原生展开/折叠（无导航）
  const toggleByRow = await run(async () => {
    document.querySelector('#file-tree > .tree-directory > summary .tree-name')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      open: document.querySelector('#file-tree > .tree-directory').open,
      root: document.getElementById('sidebar-root').title.split(String.fromCharCode(92)).join('/')
    };
  });
  assert.equal(toggleByRow.open, false, JSON.stringify(toggleByRow));
  assert.equal(toggleByRow.root, workspace.replace(/\\/g, '/'), JSON.stringify(toggleByRow));

  // 打开 更深目录/深层.md（三级深度）→ 树根 = 子目录，同样有上一级视野
  const atDeepFile = await openAndState(path.join(nestedFolder, '深层.md'));
  assert.equal(atDeepFile.root, folder.replace(/\\/g, '/'), JSON.stringify(atDeepFile));
  assert.equal(atDeepFile.active, '深层.md', JSON.stringify(atDeepFile));

  // 切换到大纲再切回：文件树恢复且大纲真正隐藏
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
    filesHidden: outlineHidden.filesHidden
  }, {
    outlineHidden: true,
    outlineDisplay: 'none',
    filesHidden: false
  }, JSON.stringify(outlineHidden));
  assert.equal(outlineHidden.root, folder.replace(/\\/g, '/'), JSON.stringify(outlineHidden));

  assert.deepEqual(errors, []);
  clearTimeout(timeout);
  console.log('Sidebar regression OK: tree rooted at parent of the document folder, row-click toggling, no trapped states.');
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
