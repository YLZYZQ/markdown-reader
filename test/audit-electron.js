'use strict';

// 无头审计：实证疑点 bug + 截取 UI 视觉审查截图。不显示窗口、不抢焦点。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const shotsDir = path.join(__dirname, 'audit-shots');
fs.rmSync(shotsDir, { recursive: true, force: true });
fs.mkdirSync(shotsDir, { recursive: true });

// 真实的目录树处理器（与 main.js 相同），用于侧边栏截图
const { listDocumentTree } = require('../lib/file-tree');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-audit-'));
fs.writeFileSync(path.join(fixtureDir, '主文档.md'), '# 主文档\n\n正文内容\n');
fs.mkdirSync(path.join(fixtureDir, '子目录'));
fs.writeFileSync(path.join(fixtureDir, '子目录', '嵌套.md'), '## 嵌套\n');
fs.writeFileSync(path.join(fixtureDir, '兄弟文档.md'), '兄弟内容\n');
fs.writeFileSync(path.join(fixtureDir, 'notes.txt'), 'note\n');

ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('document:confirmReplace', () => 'discard'); // 无头环境自动"不保存"
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('print:document', () => ({ canceled: false }));
ipcMain.handle('export:document', () => ({ canceled: false }));
ipcMain.handle('file:openPath', async (_e, filePath) => {
  const content = await fs.promises.readFile(filePath, 'utf8');
  return { filePath, content, baseUrl: 'file:///' + filePath.replace(/\\/g, '/') };
});
ipcMain.handle('directory:listForDocument', async (_e, filePath) => listDocumentTree(filePath));

let finished = false;
const timeout = setTimeout(() => finish(new Error('audit timed out')), 120000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error('[FAIL] ' + (error.stack || error));
  else console.log('[DONE] ' + JSON.stringify(report, null, 1));
  app.exit(error ? 1 : 0);
}

const report = {};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.webContents.setBackgroundThrottling(false);
  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) pageErrors.push(message);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const wc = win.webContents;
  // 隐藏窗口不产帧，CSS 动画会冻结在起始帧污染截图：审计期间禁用动画/过渡。
  await wc.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.textContent = '* { animation: none !important; transition: none !important; }';
    document.head.appendChild(style);
  })()`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function shot(name) {
    const img = await wc.capturePage();
    const buf = img.toPNG();
    fs.writeFileSync(path.join(shotsDir, name), buf);
    return buf.length;
  }

  // ---------- B5: 缩放显示公式 ----------
  wc.send('zoom:levelChanged', 1); // 真实含义 = 120%
  await wait(80);
  report.zoomLevel1Text = await wc.executeJavaScript(`document.getElementById('zoom-level').textContent`);

  // ---------- B2: 光标位置准确性（源码模式） ----------
  await wc.executeJavaScript(`(async () => {
    window.editor.changeMode('markdown');
    await new Promise(r => setTimeout(r, 100));
    const md = '# 标题\\n\\n第一段内容\\n\\n第二段内容在这里';
    window.editor.setMarkdown(md, true);
    window.__mdProbe = md;
  })()`);
  // 探测 md 模式 setSelection 的位置格式（0-based vs 1-based）
  report.mdSelectionFormat = await wc.executeJavaScript(`(() => {
    const md = window.__mdProbe;
    const results = {};
    // '第二段' 位于第 5 行（1-based），行内第 1 字符
    try {
      window.editor.setSelection([4, 0], [4, 3]); // 0-based 尝试
      results.zeroBased = window.editor.getSelectedText();
    } catch (e) { results.zeroBased = 'error: ' + e.message; }
    try {
      window.editor.setSelection([5, 1], [5, 4]); // 1-based 尝试
      results.oneBased = window.editor.getSelectedText();
    } catch (e) { results.oneBased = 'error: ' + e.message; }
    results.getSelectionShape = JSON.stringify(window.editor.getSelection());
    window.editor.focus();
    return results;
  })()`);
  await wait(400); // rAF tracker 更新
  report.cursorPosMd = await wc.executeJavaScript(`document.getElementById('cursor-pos').textContent`);
  report.cursorPosMdExpected = '第5行 第1列';

  // ww 模式光标位置探测
  report.cursorPosWw = await wc.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 100));
    window.editor.changeMode('wysiwyg');
    await new Promise(r => setTimeout(r, 150));
    const md = window.__mdProbe;
    window.editor.setMarkdown(md, true);
    // ww 模式：偏移量格式，把光标放到第 3 段开头
    const off = 6 + 6; // '# 标题' = 5 + \\n\\n(2) + '第一段内容'(5) + \\n\\n(2) => 14? 直接搜
    const target = md.indexOf('第二段');
    // ww 偏移与 md 偏移不同，这里把光标放到文档末尾再用显示值对照
    window.editor.setSelection(md.length, md.length);
    window.editor.focus();
    await new Promise(r => setTimeout(r, 300));
    return document.getElementById('cursor-pos').textContent;
  })()`);

  // ---------- B3: Ctrl+S / Ctrl+Shift+S 被 Toast UI 吞掉 ----------
  report.keySwallow = await wc.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.__kbd = [];
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 's' || e.key === 'S')) window.__kbd.push(e.defaultPrevented);
    }, false);
    window.editor.setMarkdown('内容', true);
    window.editor.setSelection(0, 2);
    window.editor.focus();
    return 'armed';
  })()`);
  await wc.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['control'] });
  await wc.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: ['control'] });
  await wait(150);
  const afterCtrlS = await wc.executeJavaScript(`({ prevented: window.__kbd[0], md: window.editor.getMarkdown() })`);
  report.ctrlS = afterCtrlS; // prevented=true 且 md 含 ~~ → 菜单保存加速键被吞
  await wc.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control', 'shift'] });
  await wc.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control', 'shift'] });
  await wait(150);
  const afterCtrlShiftS = await wc.executeJavaScript(`({ prevented: window.__kbd[1], md: window.editor.getMarkdown() })`);
  report.ctrlShiftS = afterCtrlShiftS; // prevented=true 且 md 含 ~~ → 另存为加速键被吞

  // ---------- B1/B10: window.find 自匹配 + 源码模式预览重复匹配 ----------
  await wc.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.editor.changeMode('markdown');
    await wait(100);
    window.editor.setMarkdown('alpha 文本 alpha', true);
    document.getElementById('btn-find').click();
    const findInput = document.getElementById('find-input');
    findInput.value = 'alpha';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    findInput.focus();
    findInput.select();
  })()`);
  await wait(100);
  // 第一次 Enter（选择区域在查找输入框内）
  await wc.executeJavaScript(`document.getElementById('find-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(120);
  const find1 = await wc.executeJavaScript(`({
    inFindInput: document.getElementById('find-input') === document.activeElement ||
      document.getElementById('find-input').contains(window.getSelection().anchorNode),
    inEditorSource: Boolean(window.getSelection().anchorNode &&
      window.getSelection().anchorNode.parentElement.closest('.toastui-editor-md-editor, .toastui-editor .ProseMirror')),
    inPreview: Boolean(window.getSelection().anchorNode &&
      window.getSelection().anchorNode.parentElement.closest('.toastui-editor-md-preview')),
    counter: document.getElementById('find-count').textContent
  })`);
  // 继续按两次 Enter，观察是否跳到预览里的重复文本
  await wc.executeJavaScript(`document.getElementById('find-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(120);
  const find2 = await wc.executeJavaScript(`({
    inPreview: Boolean(window.getSelection().anchorNode &&
      window.getSelection().anchorNode.parentElement.closest('.toastui-editor-md-preview')),
    inSidebarOrPanel: Boolean(window.getSelection().anchorNode &&
      (window.getSelection().anchorNode.parentElement.closest('#find-panel') ||
       window.getSelection().anchorNode.parentElement.closest('#file-sidebar')))
  })`);
  report.findFirstEnter = find1;
  report.findSecondEnter = find2;
  report.findCounter = find1.counter;

  // ---------- B9: 编辑器内按 Escape 不关闭查找面板 ----------
  const escapeCloses = await wc.executeJavaScript(`(async () => {
    const editorEl = document.querySelector('.toastui-editor');
    editorEl.focus();
    editorEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    return document.getElementById('find-panel').hidden;
  })()`);
  report.escapeClosesFind = escapeCloses;

  // ---------- B7: 全部替换后滚动位置重置 ----------
  report.replaceAllScroll = await wc.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.editor.changeMode('wysiwyg');
    await wait(150);
    const paras = Array.from({ length: 120 }, (_, i) => '段落' + i + ' 目标词').join('\\n\\n');
    window.editor.setMarkdown(paras, true);
    await wait(150);
    const container = document.querySelector('.toastui-editor-ww-container');
    container.scrollTop = container.scrollHeight;
    await wait(100);
    const before = container.scrollTop;
    document.getElementById('btn-find').click();
    const findInput = document.getElementById('find-input');
    findInput.value = '目标词';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-find-expand').click();
    const replaceInput = document.getElementById('replace-input');
    replaceInput.value = '已替换';
    document.getElementById('btn-replace-all').click();
    await wait(200);
    return { before, after: document.querySelector('.toastui-editor-ww-container').scrollTop, reset: document.querySelector('.toastui-editor-ww-container').scrollTop < 50 };
  })()`);

  // ---------- B4: 暗色主题 Mermaid 白底 ----------
  await wc.executeJavaScript(`(async () => {
    document.getElementById('btn-find-close').click();
    window.editor.setMarkdown('前文\\n\\n\`\`\`mermaid\\nflowchart LR\\nA --> B\\n\`\`\`\\n\\n后文', true);
    document.getElementById('btn-theme').click(); // 切到暗色
    await new Promise(r => setTimeout(r, 300));
  })()`);
  await wait(2500); // 等 mermaid 渲染
  report.darkMermaidBg = await wc.executeJavaScript(`(() => {
    const el = document.querySelector('.toastui-editor-md-preview .mermaid-diagram');
    return el ? getComputedStyle(el).backgroundColor : 'not-found-in-md-mode';
  })()`);
  // ww 模式下的暗色 mermaid 背景
  await wc.executeJavaScript(`window.editor.changeMode('wysiwyg')`);
  await wait(1500);
  report.darkMermaidBgWw = await wc.executeJavaScript(`(() => {
    const el = document.querySelector('.mermaid-wysiwyg-code-block');
    return el ? getComputedStyle(el).backgroundColor : 'not-found-in-ww';
  })()`);

  // ---------- 截图：暗色 + mermaid + ww ----------
  await shot('s1-dark-ww-mermaid.png');
  await shot('s2-dark-ww-mermaid-scrolled.png');

  // ---------- B8: getCurrentModeEditor().view 可达性 ----------
  report.pmViewAccessible = await wc.executeJavaScript(`(() => {
    try {
      const view = window.editor.getCurrentModeEditor().view;
      return Boolean(view && view.state && view.state.doc);
    } catch (e) { return 'error: ' + e.message; }
  })()`);

  // ---------- 截图：亮色 ww / 源码模式+查找 / 侧边栏 / 右键菜单 ----------
  await wc.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('btn-theme').click(); // 回到亮色
    await wait(400);
    window.editor.setMarkdown(['# 项目说明', '', '这是一个 **示例文档**，用于视觉审查。', '', '## 特性', '', '- 即时渲染', -'- 亮暗主题'].join('\\n'), true);
  })()`);
  await wait(400);
  await shot('s3-light-ww.png');
  await wc.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.editor.changeMode('markdown');
    await wait(200);
    document.getElementById('btn-find').click();
    document.getElementById('btn-find-expand').click();
    const fi = document.getElementById('find-input');
    fi.value = '渲染';
    fi.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);
  })()`);
  await shot('s4-light-md-find.png');

  // 侧边栏（打开 fixture 文档）
  await wc.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('btn-find-close').click();
    window.editor.changeMode('wysiwyg');
    await wait(150);
  })()`);
  const sidebarOpen = await wc.executeJavaScript(`(async () => {
    const res = await window.api.openPath(${JSON.stringify(path.join(fixtureDir, '主文档.md'))});
    if (res.error) return 'error: ' + res.error;
    return 'opened';
  })()`);
  // loadContent 不在全局作用域，直接走 system:openDocument 通道
  await wc.executeJavaScript(`window.editor.setMarkdown('# 主文档\\n\\n正文内容', true)`);
  report.sidebarFixture = sidebarOpen;
  // 模拟侧边栏：直接调用内部路径不可行 → 通过 IPC 手动获取树并检查渲染函数？改为通过 UI 无法触发。
  // 用 system:openDocument 触发完整 loadContent：
  wc.send('system:openDocument', path.join(fixtureDir, '主文档.md'));
  await wait(600);
  report.sidebarRootText = await wc.executeJavaScript(`document.getElementById('sidebar-root').textContent`);
  report.sidebarTreeFiles = await wc.executeJavaScript(`document.querySelectorAll('.tree-file').length`);
  await shot('s5-sidebar.png');

  // 右键菜单
  await wc.executeJavaScript(`(async () => {
    const editorArea = document.querySelector('.toastui-editor-main .ProseMirror');
    editorArea.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 640, clientY: 300 }));
    await new Promise(r => setTimeout(r, 120));
    const para = Array.from(document.querySelectorAll('.ctx-menu > .ctx-item')).find(el => el.dataset.menuLabel === '段落');
    para.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise(r => setTimeout(r, 120));
  })()`);
  await shot('s6-ctxmenu.png');
  await wc.executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await wait(100);

  // —— v1.3 大纲面板截图（亮色 + 暗色） ——
  await wc.executeJavaScript(`(async () => {
    const wait2 = (ms) => new Promise(r => setTimeout(r, ms));
    window.editor.changeMode('markdown');
    await wait2(150);
    window.editor.setMarkdown('# 项目说明\\n\\n介绍段落。\\n\\n## 安装\\n\\n安装内容。\\n\\n### 环境要求\\n\\n要求内容。\\n\\n## 使用\\n\\n使用内容。', true);
    document.getElementById('tab-outline').click();
    await wait2(500);
  })()`);
  await shot('s7-outline.png');
  report.outlineItems = await wc.executeJavaScript(`document.querySelectorAll('.outline-item').length`);
  await wc.executeJavaScript(`document.getElementById('btn-theme').click()`);
  await wait(500);
  await wc.executeJavaScript(`window.editor.setSelection([5, 1], [5, 1]); window.editor.focus();`);
  await wait(300);
  await shot('s8-outline-dark-active.png');
  report.outlineActiveIndex = await wc.executeJavaScript(
    `(document.querySelector('.outline-item.active') || { dataset: {} }).dataset.index || 'none'`);
  report.s8Selection = await wc.executeJavaScript(`JSON.stringify(window.editor.getSelection())`);
  report.s8CursorDisplay = await wc.executeJavaScript(`document.getElementById('cursor-pos').textContent`);
  report.s8Mode = await wc.executeJavaScript(`window.editor.getCurrentModeEditor === undefined ? '?' : (function(){ try { return window.editor.getCurrentModeEditor().view.state.doc.firstChild ? 'view-ok' : 'view-ok'; } catch (e) { return 'view-error'; } })()`);
  await wc.executeJavaScript(`document.getElementById('btn-theme').click()`);

  // ---------- 状态栏字数 ----------
  report.wordCount = await wc.executeJavaScript(`(async () => {
    window.editor.setMarkdown('# 标题\\n\\nHello 世界', true);
    await new Promise(r => setTimeout(r, 100));
    return document.getElementById('word-count').textContent;
  })()`);

  report.pageErrors = pageErrors;
  finish();
}).catch(finish);
