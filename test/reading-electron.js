'use strict';

// 阅读体验集成测试：大纲、阅读进度、CJK 字数与阅读时长、专注模式、
// 打字机模式与栏宽偏好、主题切换保留编辑器实例/选区/撤销历史。
// 截图保存到 release/reading-preview/ 供人工复核。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-reading-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
let storedPrefs = { theme: 'system', windowBounds: null, zoomLevel: 0 };
ipcMain.handle('prefs:getAll', () => storedPrefs);
const prefPatches = [];
ipcMain.on('prefs:set', (_event, patch) => prefPatches.push(patch));
ipcMain.handle('backup:take', () => null);
ipcMain.handle('recent:get', () => []);
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('directory:listForDocument', () => ({ rootPath: 'C:\\t', rootName: 't', entries: [], truncated: false }));

const screenshots = path.join(__dirname, '..', 'release', 'reading-preview');
const errors = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Reading integration timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 850,
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
  const run = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  // 隐藏窗口会冻结 CSS 过渡（主题切换截图停在过渡起始帧），截图前禁用过渡保证确定性。
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

  // —— 大纲（围栏感知 + Setext）与跳转 ——
  await run(() => {
    document.getElementById('tab-outline').click();
    window.editor.setMarkdown('# 一级标题\n\n开头正文。\n\n' + '长文阅读内容。\n\n'.repeat(28) +
      '## 二级标题\n\n第二部分\n\n```md\n# 围栏内不是标题\n```\n\nSetext 标题\n---\n\n' + '末尾正文。\n\n'.repeat(20), false);
  });
  await wait(500);
  const outline = await run(() => ({
    items: [...document.querySelectorAll('.outline-item .outline-text')].map((el) => el.textContent),
    levels: [...document.querySelectorAll('.outline-item .outline-level')].map((el) => el.textContent)
  }));
  assert.deepEqual(outline.items, ['一级标题', '二级标题', 'Setext 标题'], JSON.stringify(outline));
  assert.deepEqual(outline.levels, ['H1', 'H2', 'H2'], JSON.stringify(outline));
  await run(() => document.querySelectorAll('.outline-item')[1].click());
  await wait(250);
  const jump = await run(() => ({
    active: [...document.querySelectorAll('.outline-item')].findIndex((item) => item.classList.contains('active')),
    progress: document.getElementById('reading-progress').textContent
  }));
  assert.equal(jump.active, 1, JSON.stringify(jump));
  assert(/^\d+%$/.test(jump.progress), jump.progress);
  await capture('outline');

  // —— 阅读进度随滚动变化 ——
  const scrolled = await run(async () => {
    const scroller = document.querySelector('.toastui-editor-ww-container .ProseMirror');
    scroller.scrollTop = Math.floor(scroller.scrollHeight * 0.6);
    await new Promise((resolve) => setTimeout(resolve, 350));
    return document.getElementById('reading-progress').textContent;
  });
  assert.notEqual(scrolled, '0%', scrolled);
  assert.notEqual(scrolled, '100%', scrolled);

  // —— CJK 感知字数与阅读时长 ——
  const counts = await run(async () => {
    window.editor.setMarkdown('# 统计\n\n中文正文十二字 mixed with seven words。\n\n```js\nconst code = 1;\n```\n\n| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |', false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    return {
      count: document.getElementById('word-count').textContent,
      countTitle: document.getElementById('word-count').title,
      time: document.getElementById('reading-time').textContent,
      timeTitle: document.getElementById('reading-time').title
    };
  });
  assert(counts.count.endsWith(' 字符'), counts.count);
  assert(/中日韩文字 \d+ 字，其他文字 \d+ 词/.test(counts.countTitle), counts.countTitle);
  assert(/^约 \d+ 分钟$/.test(counts.time), counts.time);
  assert(counts.timeTitle.includes('400 字/分钟'), counts.timeTitle);

  // —— 专注模式：进入/当前块高亮/退出 ——
  const focus = await run(async () => {
    document.getElementById('btn-focus').click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const editorEl = document.getElementById('editor');
    const root = editorEl.querySelector('.toastui-editor-ww-container .ProseMirror');
    const second = root.children[2];
    const range = document.createRange();
    range.selectNodeContents(second);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editorEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const dimRule = [...document.querySelectorAll('head style')].map((s) => s.textContent).join('\n');
    return {
      bodyFocus: document.body.classList.contains('focus-mode'),
      pressed: document.getElementById('btn-focus').getAttribute('aria-pressed'),
      sidebarInert: document.getElementById('file-sidebar').inert === true,
      toolbarHidden: getComputedStyle(editorEl.querySelector('.toastui-editor-defaultUI-toolbar')).display === 'none',
      dimmed: dimRule.includes('opacity: 0.32') && dimRule.includes(':not(:nth-child(3))'),
      escapeWorks: (() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return !document.body.classList.contains('focus-mode');
      })()
    };
  });
  assert.equal(focus.bodyFocus, true, JSON.stringify(focus));
  assert.equal(focus.pressed, 'true');
  assert.equal(focus.sidebarInert, true);
  assert.equal(focus.toolbarHidden, true);
  assert.equal(focus.dimmed, true);
  assert.equal(focus.escapeWorks, true);
  await run(() => document.getElementById('btn-focus').click());
  await capture('focus');

  // —— 排版设置：栏宽、打字机、字号走偏好持久化 ——
  const settings = await run(async () => {
    const contents = document.querySelector('.toastui-editor-ww-container .toastui-editor-contents');
    const before = getComputedStyle(contents).paddingLeft;
    document.getElementById('btn-reading-settings').click();
    const width = document.getElementById('line-width');
    width.value = '960';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    const typewriter = document.getElementById('typewriter-toggle');
    typewriter.checked = true;
    typewriter.dispatchEvent(new Event('change', { bubbles: true }));
    const size = document.getElementById('font-size');
    size.value = '20';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      varWidth: document.documentElement.style.getPropertyValue('--reading-width'),
      after: getComputedStyle(contents).paddingLeft,
      fontVar: document.documentElement.style.getPropertyValue('--md-reader-font-size'),
      typewriter: document.body.classList.contains('typewriter-mode'),
      panelOpen: !document.getElementById('reading-settings').hidden
    };
  });
  assert.equal(settings.varWidth.trim(), '960px', JSON.stringify(settings));
  assert.notEqual(settings.after, settings.before);
  assert.equal(settings.fontVar.trim(), '20px');
  assert.equal(settings.typewriter, true);
  assert(prefPatches.some((p) => p && p.readingLineWidth === 960), JSON.stringify(prefPatches));
  assert(prefPatches.some((p) => p && p.typewriterMode === true));
  assert(prefPatches.some((p) => p && p.editorFontSize === 20));
  await run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  // —— 主题切换：保留实例 / 选区 / 撤销历史 ——
  const theme = await run(async () => {
    const editor = window.editor;
    editor.setMarkdown('起点', false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    editor.setSelection(3);
    editor.insertText('新增');
    const before = editor.getMarkdown();
    const selection = JSON.stringify(editor.getSelection());
    document.getElementById('btn-theme').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const same = editor === window.editor;
    const retained = JSON.stringify(editor.getSelection()) === selection;
    const content = editor.getMarkdown();
    editor.exec('undo');
    return {
      same, retained, before, content, undo: editor.getMarkdown(),
      darkClass: Boolean(document.querySelector('#editor .toastui-editor-defaultUI').classList.contains('toastui-editor-dark')),
      bodyDark: document.body.classList.contains('theme-dark'),
      icon: document.getElementById('theme-icon').textContent
    };
  });
  assert.equal(theme.same, true, JSON.stringify(theme));
  assert.equal(theme.retained, true);
  assert.equal(theme.before, theme.content);
  assert.equal(theme.undo, '起点');
  assert.equal(theme.darkClass, true);
  assert.equal(theme.bodyDark, true);
  assert(prefPatches.some((p) => p && p.theme === 'dark'));
  await capture('dark');
  await run(() => document.getElementById('btn-theme').click());
  await wait(250);

  // —— 偏好回读：重启路径下栏宽/打字机生效 ——
  storedPrefs = { theme: 'dark', readingLineWidth: 640, typewriterMode: true, editorFontSize: 18 };
  const reloaded = await run(async () => {
    const fresh = await window.api.getPreferences();
    return {
      width: fresh.readingLineWidth,
      typewriter: fresh.typewriterMode,
      size: fresh.editorFontSize
    };
  });
  assert.deepEqual(reloaded, { width: 640, typewriter: true, size: 18 }, JSON.stringify(reloaded));

  assert.deepEqual(errors, []);
  clearTimeout(timeout);
  console.log('Reading experience OK: outline, progress, CJK counts, focus, settings persistence, theme retention.');
  console.log('Screenshots:', screenshots);
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
