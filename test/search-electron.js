'use strict';

// 查找回归测试（移植自 9月16 草稿，适配 v1.4.3 结构）：
// 长文滚动定位（双模式）、回绕、输入即跳转、CSS Highlight 高亮、
// 行内格式跨节点命中、大小写、替换的事务性（单步撤销、不误伤隐藏链接地址）、
// 专注模式下的查找可用性。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-search-')));
app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('backup:take', () => null);
ipcMain.handle('recent:get', () => []);
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('directory:listForDocument', () => ({ rootPath: 'C:\\t', rootName: 't', entries: [], truncated: false }));
const timeout = setTimeout(() => { console.error('Search test timed out'); app.exit(1); }, 60000);
const errors = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
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
  const result = await win.webContents.executeJavaScript('(' + (async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(400);
    const editor = window.editor;
    const input = document.getElementById('find-input');
    const snapshot = async () => {
      await wait(60); // 离屏渲染下滚动写入在下一帧提交，先等一帧再读
      const root = editor.getCurrentModeEditor().view.dom;
      const range = [...(CSS.highlights.get('search-current') || [])][0];
      const rect = range?.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const panel = document.getElementById('find-panel').getBoundingClientRect();
      return {
        text: range?.toString(), count: document.getElementById('find-count').textContent,
        scroll: root.scrollTop, focused: document.activeElement === input,
        visible: Boolean(rect && rect.top >= Math.max(bounds.top, panel.bottom) && rect.bottom <= bounds.bottom),
        insideEditor: Boolean(range && root.contains(range.startContainer))
      };
    };
    const search = (text) => {
      input.focus(); input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const cases = [];
    for (const mode of ['wysiwyg', 'markdown']) {
      editor.changeMode(mode);
      await wait(200);
      editor.setMarkdown('# 远端命中\n\n' + '开头正文。\n\n'.repeat(60) + '正文远端命中第一处。\n\n' + '中间正文。\n\n'.repeat(40) + '正文远端命中第二处。\n\n' + '结尾。\n\n'.repeat(20), false);
      const before = editor.getMarkdown();
      await wait(220); // 大纲已生成，搜索不能算入侧栏的同名标题。
      document.getElementById('btn-find').click();
      editor.setScrollTop(0);
      search('正文远端命中');
      const first = await snapshot();
      document.getElementById('btn-find-next').click();
      const next = await snapshot();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      const previous = await snapshot();
      document.getElementById('btn-find-prev').click();
      const wrap = await snapshot();
      search('不存在的文字');
      const absent = { count: document.getElementById('find-count').textContent, highlight: CSS.highlights.has('search-current') };
      search('正文远端命中');
      document.getElementById('btn-find-close').click();
      cases.push({ mode, first, next, previous, wrap, absent, unchanged: before === editor.getMarkdown(), cleared: !CSS.highlights.has('search-current') });
    }
    editor.changeMode('wysiwyg');
    await wait(200);
    editor.setMarkdown('# alpha\n\n' + '段落。\n\n'.repeat(40) + 'al**ph**a 及 ALPHA\n\n`alpha`\n\n| 表格 |\n| --- |\n| alpha |\n\n[链接](https://example.com/alpha)', false);
    await wait(550); // 与设定测试文档的事务分开，模拟用户停顿后替换。
    document.getElementById('btn-find').click();
    search('alpha');
    const renderedCount = (await snapshot()).count;
    document.getElementById('btn-find-next').click();
    const splitInline = await snapshot();
    document.getElementById('find-case-sensitive').checked = true;
    document.getElementById('find-case-sensitive').dispatchEvent(new Event('change'));
    const caseCount = (await snapshot()).count;
    document.getElementById('replace-input').value = 'beta';
    document.getElementById('btn-replace-all').click();
    const replaced = editor.getMarkdown();
    const noLowerCaseHits = (await snapshot()).count;
    editor.exec('undo');
    const undo = editor.getMarkdown();
    document.getElementById('btn-find-next').click();
    const singleBefore = (await snapshot()).text;
    document.getElementById('btn-replace').click();
    const singleAfter = editor.getMarkdown();
    editor.setMarkdown('alpha\n\n' + '长文。\n\n'.repeat(60) + 'alpha\n\n' + '末尾。\n\n'.repeat(10), false);
    search('alpha');
    document.getElementById('btn-find-next').click();
    document.getElementById('btn-replace').click();
    const lastReplacement = await snapshot();
    editor.exec('undo');
    document.getElementById('btn-focus').click();
    const typewriter = document.getElementById('typewriter-toggle');
    typewriter.checked = true; typewriter.dispatchEvent(new Event('change'));
    search('alpha');
    document.getElementById('btn-find-next').click();
    await wait(200);
    const focusedSearch = await snapshot();
    document.getElementById('btn-focus').click();
    return { cases, renderedCount, splitInline, caseCount, replaced, noLowerCaseHits, undo, singleBefore, singleAfter, lastReplacement, focusedSearch };
  }).toString() + ')()');
  for (const entry of result.cases) {
    for (const key of ['first', 'next', 'previous', 'wrap']) {
      assert.equal(entry[key].text, '正文远端命中', JSON.stringify(entry));
      assert.equal(entry[key].visible, true, JSON.stringify(entry));
      assert.equal(entry[key].insideEditor, true);
    }
    assert.equal(entry.first.count, '1/2');
    assert.equal(entry.first.focused, true);
    assert(entry.first.scroll > 500, JSON.stringify(entry));
    assert(entry.next.scroll > entry.first.scroll, JSON.stringify(entry));
    assert.equal(entry.next.count, '2/2');
    assert.equal(entry.previous.count, '1/2');
    assert.equal(entry.wrap.count, '2/2');
    assert.deepEqual(entry.absent, { count: '0 处', highlight: false });
    assert.equal(entry.unchanged, true);
    assert.equal(entry.cleared, true);
  }
  assert.equal(result.renderedCount, '1/5');
  assert.equal(result.splitInline.text, 'alpha');
  assert.equal(result.splitInline.visible, true);
  assert.equal(result.caseCount, '1/4');
  assert(result.replaced.includes('https://example.com/alpha'), 'Rendering search must not replace hidden link URLs');
  assert(result.replaced.includes('ALPHA'));
  assert.equal(result.noLowerCaseHits, '0 处');
  assert(result.undo.includes('al**ph**a'), 'Replace-all must preserve a single undo step');
  assert.equal(result.singleBefore, 'alpha');
  assert(result.singleAfter.includes('beta'));
  assert.equal(result.lastReplacement.count, '1/1');
  assert.equal(result.lastReplacement.text, 'alpha');
  assert.equal(result.focusedSearch.visible, true);
  assert.deepEqual(errors, []);
  const screenshotDir = path.join(__dirname, '..', 'release', 'reading-preview');
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(screenshotDir, 'search.png'), (await win.webContents.capturePage()).toPNG());
  clearTimeout(timeout);
  console.log('Search regression OK: long-document scrolling in both modes, wrapping, live jump, highlights, inline formatting, case and transactional replacement.');
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error(error); app.exit(1); });
