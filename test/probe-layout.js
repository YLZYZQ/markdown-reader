'use strict';
// 探查：ww/md 两模式下内容列的布局链，定位 margin auto 未居中的原因。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('backup:take', () => null);
ipcMain.on('backup:write', () => {});
ipcMain.on('backup:clear', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.editor.setMarkdown('# 标题\\n\\n正文段落，用于测量布局。'.repeat(1), false);
    await wait(200);

    function describe(el) {
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        cls: (el.className || el.tagName).toString().slice(0, 55),
        display: cs.display,
        overflowY: cs.overflowY,
        width: Math.round(rect.width),
        left: Math.round(rect.left),
        marginLeft: cs.marginLeft,
        marginRight: cs.marginRight,
        maxWidth: cs.maxWidth,
        boxSizing: cs.boxSizing
      };
    }

    function chain(el) {
      const rows = [];
      let cur = el;
      while (cur && cur !== document.body) {
        rows.push(describe(cur));
        cur = cur.parentElement;
      }
      return rows;
    }

    // ww 模式
    const wwContents = document.querySelector('.toastui-editor-ww-container .ProseMirror');
    const wwChain = chain(wwContents);

    // md 模式（源码 + 预览）
    window.editor.changeMode('markdown');
    await wait(250);
    const mdPreviewContents = document.querySelector('.toastui-editor-md-preview .toastui-editor-contents');
    const mdChain = chain(mdPreviewContents);

    // 居中验证：列左缘与父容器左缘的间距应近似等于右侧间距
    const summarize = (rows) => rows && rows.length ? {
      left: rows[0].left,
      width: rows[0].width,
      parentLeft: rows[1] ? rows[1].left : null,
      parentWidth: rows[1] ? rows[1].width : null,
      leftGap: rows[1] ? rows[0].left - rows[1].left : null,
      rightGap: (rows[1] && rows[0].width && rows[1].width) ? Math.round(rows[1].width - rows[0].width - (rows[0].left - rows[1].left)) : null
    } : null;

    return { ww: summarize(wwChain), md: summarize(mdChain), wwDetail: wwChain && wwChain[0], wwStyleRules: (() => {
      const el = wwContents;
      const hits = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const rule of rules) {
          if (!rule.selectorText || !rule.style) continue;
          if (!/margin|width/.test(rule.cssText)) continue;
          try {
            if (el.matches(rule.selectorText)) {
              hits.push({ sel: rule.selectorText.slice(0, 90), css: rule.style.cssText.slice(0, 140) });
            }
          } catch (_) { /* 跳过不匹配的选择器 */ }
        }
      }
      return hits;
    })() };
  })()`);
  console.log(JSON.stringify(out, null, 1));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
