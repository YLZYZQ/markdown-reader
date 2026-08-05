'use strict';

const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('app:getInitialFile', () => null);
ipcMain.handle('image:saveBlob', (_event, _filePath, _fileName, arrayBuffer) => ({
  isArrayBuffer: arrayBuffer instanceof ArrayBuffer,
  byteLength: arrayBuffer.byteLength
}));

let finished = false;
const timeout = setTimeout(() => finish(new Error('Electron smoke test timed out')), 15000);

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  clipboard.writeText('菜单粘贴测试');
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const pageErrors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (/TextSelection endpoint not pointing into a node with inline content/.test(message)) return;
    if (level >= 2 || /content security policy|uncaught/i.test(message)) pageErrors.push(message);
  });
  window.webContents.on('did-fail-load', (_event, code, description) => {
    finish(new Error(`Renderer failed to load (${code}): ${description}`));
  });

  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  let state;
  try {
    state = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(250);

    async function activateContextItem(sectionLabel, itemLabel) {
      const editorArea = Array.from(document.querySelectorAll('.toastui-editor-main .ProseMirror'))
        .find((element) => element.offsetParent !== null);
      editorArea.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 120
      }));

      let scope = document.querySelector('.ctx-menu:not(.ctx-submenu)');
      if (sectionLabel) {
        const section = Array.from(scope.querySelectorAll(':scope > .ctx-item'))
          .find((row) => row.dataset.menuLabel === sectionLabel);
        section.dispatchEvent(new MouseEvent('mouseenter'));
        scope = document.querySelector('.ctx-submenu');
      }
      const item = Array.from(scope.querySelectorAll(':scope > .ctx-item'))
        .find((row) => row.dataset.menuLabel === itemLabel);
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await wait(30);
    }

    async function commandResult(section, item, initialValue = '内容') {
      window.editor.setMarkdown(initialValue, true);
      window.editor.focus();
      await activateContextItem(section, item);
      return window.editor.getMarkdown();
    }

    const commandResults = {
      paragraph: await commandResult('段落', '正文', '# 内容'),
      heading: await commandResult('段落', '1 级标题'),
      heading2: await commandResult('段落', '2 级标题'),
      heading3: await commandResult('段落', '3 级标题'),
      heading4: await commandResult('段落', '4 级标题'),
      heading5: await commandResult('段落', '5 级标题'),
      heading6: await commandResult('段落', '6 级标题'),
      quote: await commandResult('段落', '引用块'),
      bulletList: await commandResult('段落', '无序列表'),
      orderedList: await commandResult('段落', '有序列表'),
      taskList: await commandResult('段落', '任务列表'),
      paragraphCodeBlock: await commandResult('段落', '代码块'),
      insertCodeBlock: await commandResult('插入', '代码块'),
      hr: await commandResult('插入', '水平分割线'),
      dateTime: await commandResult('插入', '日期时间', '')
    };

    const popupResults = {};
    for (const [label, className] of [
      ['图片…', 'toastui-editor-popup-add-image'],
      ['链接…', 'toastui-editor-popup-add-link'],
      ['表格', 'toastui-editor-popup-add-table']
    ]) {
      window.editor.setMarkdown('内容', true);
      await activateContextItem('插入', label);
      const popup = document.querySelector('.' + className);
      popupResults[label] = Boolean(popup && getComputedStyle(popup).display !== 'none');
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }

    const formatResults = {};
    for (const [label, key] of [
      ['加粗', 'bold'],
      ['斜体', 'italic'],
      ['删除线', 'strike'],
      ['行内代码', 'code']
    ]) {
      window.editor.setMarkdown('格式文本', false);
      window.editor.setSelection(1, 5);
      await activateContextItem('格式', label);
      formatResults[key] = window.editor.getMarkdown();
    }

    window.editor.setMarkdown('- 第一项\\n- 第二项', false);
    window.editor.setSelection(12);
    await activateContextItem('格式', '增加缩进');
    formatResults.indent = window.editor.getMarkdown();
    await activateContextItem('格式', '减少缩进');
    formatResults.outdent = window.editor.getMarkdown();

    const rootResults = {};
    window.editor.setMarkdown('复制文本', false);
    window.editor.setSelection(1, 5);
    await activateContextItem(null, '复制');
    window.editor.setMarkdown('', true);
    await activateContextItem(null, '粘贴');
    rootResults.copyPaste = window.editor.getMarkdown();

    window.editor.setMarkdown('剪切文本', false);
    window.editor.setSelection(1, 5);
    await activateContextItem(null, '剪切');
    rootResults.afterCut = window.editor.getMarkdown();
    window.editor.setMarkdown('', true);
    await activateContextItem(null, '粘贴');
    rootResults.cutPaste = window.editor.getMarkdown();
    rootResults.themeBefore = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    await activateContextItem(null, '切换主题');
    rootResults.themeAfter = document.body.classList.contains('theme-dark') ? 'dark' : 'light';

    window.editor.setMarkdown('', false);
    window.editor.insertText('撤销测试');
    await activateContextItem(null, '撤销');
    rootResults.afterUndo = window.editor.getMarkdown();
    await activateContextItem(null, '重做');
    rootResults.afterRedo = window.editor.getMarkdown();

    window.editor.setMarkdown('查找 alpha，再次 alpha', false);
    await activateContextItem(null, '替换…');
    const findInput = document.getElementById('find-input');
    const replaceInput = document.getElementById('replace-input');
    findInput.value = 'alpha';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    replaceInput.value = 'beta';
    document.getElementById('btn-find-next').click();
    rootResults.findCount = document.getElementById('find-count').textContent;
    document.getElementById('btn-replace-all').click();
    rootResults.replaced = window.editor.getMarkdown();
    document.getElementById('btn-find-close').click();

    rootResults.modeBefore = document.getElementById('btn-mode').textContent;
    await activateContextItem(null, '切换源码模式');
    rootResults.modeAfter = document.getElementById('btn-mode').textContent;
    rootResults.markdownModeHeading = await commandResult('段落', '2 级标题');

    const workspace = document.getElementById('workspace');
    rootResults.sidebarBefore = workspace.classList.contains('sidebar-collapsed');
    document.getElementById('btn-sidebar').click();
    rootResults.sidebarAfter = workspace.classList.contains('sidebar-collapsed');
    rootResults.sidebarExpanded = document.getElementById('btn-sidebar').getAttribute('aria-expanded');
    document.getElementById('btn-sidebar').click();

    const assetUrls = Array.from(document.querySelectorAll('link[href]'), (link) => link.href);
    document.getElementById('document-base').href = 'file:///C:/markdown-document/';
    const ipcResult = await window.api.saveImageBlob(
      'document.md',
      'image.png',
      new Uint8Array([1, 2, 3]).buffer
    );

    return {
      editorReady: Boolean(window.editor),
      apiReady: Boolean(window.api && window.api.openFile && window.api.listDirectoryForDocument),
      title: document.title,
      hasToolbar: Boolean(document.querySelector('.toastui-editor-defaultUI-toolbar')),
      hasSidebar: Boolean(document.getElementById('file-sidebar') && document.getElementById('file-tree')),
      assetsPinned: assetUrls.every((url, index) => document.querySelectorAll('link[href]')[index].href === url),
      arrayBufferIpc: ipcResult.isArrayBuffer && ipcResult.byteLength === 3,
      commandResults,
      popupResults,
      formatResults,
      rootResults
    };
    })()`);
  } catch (error) {
    throw new Error(`Renderer script failed: ${error.message}; console: ${pageErrors.join(' | ')}`);
  }

  if (!state.editorReady || !state.apiReady || !state.hasToolbar || !state.hasSidebar || !state.assetsPinned || !state.arrayBufferIpc) {
    finish(new Error(`Renderer did not initialize: ${JSON.stringify(state)}`));
    return;
  }
  if (pageErrors.length > 0) {
    finish(new Error(`Renderer console errors: ${pageErrors.join(' | ')}`));
    return;
  }

  const commands = state.commandResults;
  const commandsWork =
    commands.paragraph === '内容' &&
    /^# 内容/m.test(commands.heading) &&
    /^## 内容/m.test(commands.heading2) &&
    /^### 内容/m.test(commands.heading3) &&
    /^#### 内容/m.test(commands.heading4) &&
    /^##### 内容/m.test(commands.heading5) &&
    /^###### 内容/m.test(commands.heading6) &&
    /^> 内容/m.test(commands.quote) &&
    /^[-*+] 内容/m.test(commands.bulletList) &&
    /^1\. 内容/m.test(commands.orderedList) &&
    /^[-*+] \[ \] 内容/m.test(commands.taskList) &&
    /```[\s\S]*内容[\s\S]*```/.test(commands.paragraphCodeBlock) &&
    /```[\s\S]*内容[\s\S]*```/.test(commands.insertCodeBlock) &&
    /\*\*\*/.test(commands.hr) &&
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(commands.dateTime);
  if (!commandsWork || !Object.values(state.popupResults).every(Boolean)) {
    finish(new Error(`Context menu regression: ${JSON.stringify({ commands, popups: state.popupResults })}`));
    return;
  }
  const formats = state.formatResults;
  const formatsWork =
    /\*\*格式文本\*\*/.test(formats.bold) &&
    /\*格式文本\*/.test(formats.italic) &&
    /~~格式文本~~/.test(formats.strike) &&
    /`格式文本`/.test(formats.code) &&
    /^\s{2,}[-*+] 第二项/m.test(formats.indent) &&
    /^[-*+] 第二项/m.test(formats.outdent);
  if (!formatsWork) {
    finish(new Error(`Context menu format regression: ${JSON.stringify(formats)}`));
    return;
  }
  const root = state.rootResults;
  if (
    root.copyPaste !== '复制文本' ||
    root.afterCut !== '' ||
    root.cutPaste !== '剪切文本' ||
    root.themeBefore === root.themeAfter ||
    root.afterUndo !== '' ||
    root.afterRedo !== '撤销测试' ||
    root.findCount !== '1/2' ||
    root.replaced !== '查找 beta，再次 beta' ||
    root.modeBefore === root.modeAfter ||
    root.sidebarBefore === root.sidebarAfter ||
    root.sidebarExpanded !== String(root.sidebarBefore) ||
    !/^## 内容/m.test(root.markdownModeHeading)
  ) {
    finish(new Error(`Context menu clipboard regression: ${JSON.stringify(root)}`));
    return;
  }

  console.log(`Electron renderer and context menus OK: ${state.title}`);
  finish();
}).catch(finish);
