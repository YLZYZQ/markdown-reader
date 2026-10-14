'use strict';

// 任务列表（task list）渲染回归测试：阅读排版对 li 的 padding 覆盖
// 曾把 task-list-item 的 24px 缩进压成 0.25em，绝对定位的复选框
// 因此盖住每项开头的第一个字符。此测试度量复选框与首字符的几何
// 关系，浅色/深色主题各验证一遍，并截图供人工复核。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-tasklist-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
let storedPrefs = { theme: 'system', windowBounds: null, zoomLevel: 0 };
ipcMain.handle('prefs:getAll', () => storedPrefs);
ipcMain.on('prefs:set', (_event, patch) => { storedPrefs = { ...storedPrefs, ...patch }; });
ipcMain.handle('backup:take', () => null);
ipcMain.handle('recent:get', () => []);
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('directory:listForDocument', () => ({ rootPath: 'C:\\t', rootName: 't', entries: [], truncated: false }));

const screenshots = path.join(__dirname, '..', 'release', 'tasklist-preview');
const errors = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Task list integration timed out'); app.exit(1); }, 60000);

const SAMPLE = [
  '## 知识点清单',
  '',
  '- [ ] 误区：画一条线连三个点就当三推做反转',
  '- [ ] 推数可超过三：三推后可能有第四推、第五推',
  '- [ ] wedge 反转目标位：最小目标是第二推的起点',
  '- [x] 已完成项：平衡三推的判断标准',
  ''
].join('\n');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 760,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false
    }
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !/TextSelection endpoint/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(400);
  fs.mkdirSync(screenshots, { recursive: true });
  const run = (fn, ...args) => win.webContents.executeJavaScript(
    `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`);
  await run(() => {
    const style = document.createElement('style');
    style.id = 'test-no-transition';
    style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
    document.head.appendChild(style);
  });
  const capture = async (name) => {
    await wait(250);
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };

  await run((md) => window.editor.setMarkdown(md, false), SAMPLE);
  await wait(500);

  // 度量每个任务项：复选框 ::before（absolute, left:0, 18px 宽）相对
  // li 定位；首个非空文本字符的 Range 矩形必须完整落在复选框右缘之外。
  const measureRendered = () => {
    const items = [...document.querySelectorAll('.toastui-editor-ww-container .toastui-editor-contents li.task-list-item')];
    return items.map((li) => {
      const liStyle = getComputedStyle(li);
      const liRect = li.getBoundingClientRect();
      // ::before 以定位祖先为基准；li relative 时基准即 li 的 padding box 左缘（无 border）。
      const checkboxLeft = liStyle.position === 'relative'
        ? liRect.left + parseFloat(liStyle.borderLeftWidth || '0')
        : liRect.left;
      const checkboxRight = checkboxLeft + 18;
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.nodeValue.trim()) node = walker.nextNode();
      let offset = node ? node.nodeValue.search(/\S/) : -1;
      if (node && offset < 0) { node = walker.nextNode(); if (node) offset = node.nodeValue.search(/\S/); }
      if (!node || offset < 0) return { firstText: li.textContent.trim().charAt(0), noTextNode: true, overlap: false };
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const charRect = range.getBoundingClientRect();
      return {
        firstText: node.nodeValue.charAt(offset),
        liPaddingLeft: liStyle.paddingLeft,
        liMarginLeft: liStyle.marginLeft,
        position: liStyle.position,
        checkboxLeft,
        checkboxRight,
        charLeft: charRect.left,
        charRight: charRect.right,
        overlap: charRect.left < checkboxRight - 0.5
      };
    });
  };

  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      // 主题循环 light → cream → dark，连点两次到深色。
      await run(() => { document.getElementById('btn-theme').click(); document.getElementById('btn-theme').click(); });
      await wait(300);
    }
    const bodyTheme = await run(() => document.body.className);
    if (theme === 'dark') {
      assert.ok(/(^|\s)theme-dark(\s|$)/.test(bodyTheme), `expected theme-dark on body, got "${bodyTheme}"`);
    } else {
      assert.ok(!/(^|\s)theme-dark(\s|$)/.test(bodyTheme), `expected non-dark body, got "${bodyTheme}"`);
    }
    const rows = await run(measureRendered);
    assert.ok(rows.length >= 4, `expected >=4 task items in ${theme}, got ${rows.length}`);
    for (const row of rows) {
      assert.ok(!row.noTextNode, `task item missing text node (${theme})`);
      assert.ok(!row.overlap,
        `${theme}: first char "${row.firstText}" covered by checkbox ` +
        `(charLeft=${row.charLeft.toFixed(1)} < checkboxRight=${row.checkboxRight.toFixed(1)}, ` +
        `paddingLeft=${row.liPaddingLeft}, marginLeft=${row.liMarginLeft}, position=${row.position})`);
      assert.ok(row.charRight > row.charLeft, `${theme}: first char has zero width`);
    }
    const texts = await run(() =>
      [...document.querySelectorAll('.toastui-editor-ww-container li.task-list-item')]
        .map((li) => li.textContent.trim().slice(0, 4)));
    assert.ok(texts[0].startsWith('误区'), `item0 text starts with 误区, got ${JSON.stringify(texts)}`);
    assert.ok(texts[2].startsWith('wed'), `item2 text starts with wedge, got ${JSON.stringify(texts)}`);
    await capture(`tasklist-${theme}`);
  }

  await win.destroy();
  if (errors.length) { console.error('console errors:', errors); app.exit(1); return; }
  clearTimeout(timeout);
  console.log('tasklist-electron: all assertions passed');
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
