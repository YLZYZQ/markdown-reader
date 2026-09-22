'use strict';

// 超链接回归：WYSIWYG 的 contenteditable 链接与源码模式预览链接都必须
// 通过受限 IPC 交给系统打开；文档内锚点不得触发外部打开。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-link-')));
app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('backup:take', () => null);
ipcMain.handle('recent:get', () => []);
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('directory:listForDocument', () => ({ rootPath: 'C:\\t', rootName: 't', entries: [], truncated: false }));

const openedUrls = [];
ipcMain.handle('shell:openExternal', (_event, url) => {
  openedUrls.push(url);
  return true;
});

const timeout = setTimeout(() => {
  console.error('Link test timed out');
  app.exit(1);
}, 60000);
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
      backgroundThrottling: false
    }
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !/TextSelection endpoint/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(400);

  const result = await win.webContents.executeJavaScript('(' + (async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const externalHref = 'https://example.com/md-reader-link';
    const cases = [];
    for (const mode of ['wysiwyg', 'markdown']) {
      window.editor.changeMode(mode);
      await wait(200);
      window.editor.setMarkdown(
        '[外部链接](https://example.com/md-reader-link)\n\n[文档内锚点](#section)\n\n' +
          '长正文，用于让标题离开首屏。\n\n'.repeat(80) +
          '# Section\n\n结尾。',
        false
      );
      await wait(300);
      window.editor.setScrollTop(0);
      await wait(80);
      const links = [...document.querySelectorAll('#editor a[href]')]
        .filter((link) => link.href === externalHref && link.getClientRects().length > 0);
      const link = links[links.length - 1];
      const external = link.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0
      }));
      await wait(100);
      const anchor = [...document.querySelectorAll('#editor a[href]')]
        .find((item) => item.getAttribute('href') === '#section');
      const surface = window.editor.isMarkdownMode()
        ? document.querySelector('.toastui-editor-md-preview .toastui-editor-contents')
        : document.querySelector('.toastui-editor-ww-container .ProseMirror');
      const heading = [...surface.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .find((item) => item.textContent.trim() === 'Section');
      const anchorClick = anchor.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0
      }));
      await wait(200);
      const anchorTop = heading ? heading.getBoundingClientRect().top : null;
      // 源码/预览同步还有延迟动画，跳转成功后也不能被旧动画拉回。
      if (mode === 'markdown') await wait(1100);
      cases.push({
        mode,
        rendered: Boolean(link),
        defaultPrevented: !external,
        anchorDefaultPrevented: !anchorClick,
        anchorTop,
        settledAnchorTop: heading ? heading.getBoundingClientRect().top : null
      });
    }
    return cases;
  }).toString() + ')()');

  for (const item of result) {
    assert.equal(item.rendered, true, JSON.stringify(item));
    assert.equal(item.defaultPrevented, true, JSON.stringify(item));
    assert.equal(item.anchorDefaultPrevented, true, JSON.stringify(item));
    assert(item.anchorTop !== null && item.anchorTop >= 0 && item.anchorTop < 600, JSON.stringify(item));
    assert(item.settledAnchorTop !== null && item.settledAnchorTop >= 0 && item.settledAnchorTop < 600, JSON.stringify(item));
  }
  assert.deepEqual(openedUrls, [
    'https://example.com/md-reader-link',
    'https://example.com/md-reader-link'
  ], JSON.stringify(openedUrls));
  assert.deepEqual(errors, []);
  clearTimeout(timeout);
  console.log('Link regression OK: plain clicks open external links in both editor modes.');
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
