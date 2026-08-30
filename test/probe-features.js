'use strict';
// 能力盘点探针：验证 Toast UI 内置/缺失的 Markdown 扩展渲染能力。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 500));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const results = {};
    const md = [
      '---',
      'title: 测试文档',
      'date: 2026-08-30',
      '---',
      '',
      '# 标题',
      '',
      '数学：$E = mc^2$',
      '',
      '$$',
      'a^2 + b^2 = c^2',
      '$$',
      '',
      '脚注引用[^1]',
      '',
      '[^1]: 脚注内容',
      '',
      '[TOC]',
      '',
      '- [ ] 未完成任务',
      '- [x] 已完成任务',
      '',
      ':smile: 表情',
      '',
      '==高亮文本==',
      '',
      '缩写术语定义？',
    ].join('\\n');
    window.editor.setMarkdown(md, false);
    await wait(400);
    const preview = document.querySelector('.toastui-editor-md-preview');
    const pw = preview ? preview.textContent : '';

    // 源码模式 front matter 原文是否保留
    const mdNow = window.editor.getMarkdown();

    // 任务列表复选框在预览里是否可交互
    const previewCheckbox = preview ? preview.querySelector('input[type="checkbox"]') : null;
    results.previewCheckboxDisabled = previewCheckbox ? previewCheckbox.disabled : 'no-checkbox';

    // ww 模式任务列表：点击复选框是否能切换
    window.editor.changeMode('wysiwyg');
    await wait(200);
    const wwCheckbox = document.querySelector('.toastui-editor-ww-container input[type="checkbox"], .toastui-editor-ww-container .task-list-item');
    let wwToggle = 'no-checkbox';
    const wwBox = document.querySelector('.toastui-editor-ww-container input[type="checkbox"]');
    if (wwBox) {
      const before = window.editor.getMarkdown();
      wwBox.click();
      await wait(150);
      const after = window.editor.getMarkdown();
      wwToggle = before !== after ? 'toggle-ok' : 'click-no-effect';
    }
    results.wwTaskToggle = wwToggle;

    results.frontMatterPreserved = mdNow.includes('title: 测试文档');
    results.previewHasTitleMeta = pw.includes('测试文档');
    results.mathRenderedAsMath = Boolean(preview.querySelector('.katex, .MathJax, mjx-container'));
    results.mathAsPlainText = pw.includes('a^2 + b^2');
    results.footnoteSection = pw.includes('脚注内容') && /\\^1|footnote|sup/i.test(preview.innerHTML);
    results.tocMacroRendered = !pw.includes('[TOC]');
    results.emojiShortcode = pw.includes(':smile:') ? 'raw' : (pw.includes('😄') ? 'rendered' : 'stripped');
    results.highlightMark = Boolean(preview.querySelector('mark')) || pw.includes('==高亮==');
    results.wwMode = window.editor.getCurrentModeEditor === undefined ? '?' : 'ok';
    return results;
  })()`);
  console.log(JSON.stringify(out, null, 1));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
