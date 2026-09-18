'use strict';

const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('disable-gpu');
ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
const prefPatches = [];
ipcMain.on('prefs:set', (_event, patch) => prefPatches.push(patch));
const exportCalls = [];
ipcMain.handle('export:document', (_event, format, markdown) => {
  exportCalls.push({ format, markdownIsString: typeof markdown === 'string' });
  return { canceled: false, filePath: 'C:\\tmp\\out.' + format };
});
ipcMain.handle('print:document', () => ({ canceled: false }));
const backupWrites = [];
ipcMain.on('backup:write', (_event, session) => backupWrites.push(session));
ipcMain.on('backup:clear', () => backupWrites.push({ cleared: true }));
ipcMain.handle('backup:take', () => null);
ipcMain.handle('backup:confirmRestore', () => 'discard');
ipcMain.handle('recent:get', () => []);
const autoSaves = [];
ipcMain.handle('file:save', async (_event, filePath, content) => {
  autoSaves.push({ filePath, content });
  return { canceled: false, filePath: filePath || 'C:\\fixture\\out.md', baseUrl: 'file:///C:/fixture/' };
});
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('file:openPath', (_event, filePath) => ({
  filePath,
  content: '# 通过系统关联打开',
  baseUrl: 'file:///C:/fixture/'
}));
ipcMain.handle('directory:listForDocument', () => ({
  rootPath: 'C:\\fixture',
  rootName: 'fixture',
  entries: [],
  truncated: false
}));
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
      sandbox: true,
      backgroundThrottling: false
    }
  });
  // 隐藏窗口默认节流 setTimeout/rAF，会让时序敏感的断言失真。
  window.webContents.setBackgroundThrottling(false);

  const pageErrors = [];
  window.webContents.on('console-message', (_event, level, message) => {
    if (/TextSelection endpoint not pointing into a node with inline content/.test(message)) return;
    if (level >= 2 || /content security policy|uncaught/i.test(message)) pageErrors.push(message);
  });
  window.webContents.on('did-fail-load', (_event, code, description) => {
    finish(new Error(`Renderer failed to load (${code}): ${description}`));
  });

  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const blankState = await window.webContents.executeJavaScript(`({
    markdown: window.editor.getMarkdown(),
    title: document.title,
    welcomePresent: document.body.textContent.includes('欢迎使用 Markdown 阅读器')
  })`);
  if (blankState.markdown !== '' || blankState.welcomePresent || blankState.title !== '未命名.md - Markdown阅读器') {
    finish(new Error(`Blank startup regression: ${JSON.stringify(blankState)}`));
    return;
  }

  window.webContents.send('system:openDocument', 'C:\\fixture\\关联打开.md');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const systemOpenState = await window.webContents.executeJavaScript(`({
    markdown: window.editor.getMarkdown(),
    title: document.title
  })`);
  if (systemOpenState.markdown !== '# 通过系统关联打开' || systemOpenState.title !== '关联打开.md - Markdown阅读器') {
    finish(new Error(`System open regression: ${JSON.stringify(systemOpenState)}`));
    return;
  }

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

    // 与应用真实换文档路径一致：replaceEditorContent 重建编辑器并清空撤销历史，
    // 防止 Ctrl+Z 把上一份文档的内容带回新文档。
    replaceEditorContent('');
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
    // 输入即跳转：输入事件后应立即定位到第 1 处命中。
    rootResults.findLiveJump = document.getElementById('find-count').textContent;
    replaceInput.value = 'beta';
    document.getElementById('btn-find-next').click();
    rootResults.findCount = document.getElementById('find-count').textContent;
    document.getElementById('btn-replace-all').click();
    rootResults.replaced = window.editor.getMarkdown();
    document.getElementById('btn-find-close').click();

    // —— 回归：全部替换后保持滚动位置 ——
    // 隐藏窗口不产帧（rAF 回调不执行、滚动偏移冻结），因此用属性拦截验证
    // 替换过程不发出滚动指令（PM 事务不触碰 scrollTop，位置天然保持）。
    const longParas = Array.from({ length: 120 }, (_, i) => '段落' + i + ' 目标词').join('\\n\\n');
    window.editor.setMarkdown(longParas, false);
    await wait(200);
    const scroller = Array.from(document.querySelectorAll('.toastui-editor .ProseMirror'))
      .find((el) => el.offsetParent !== null);
    const scrollWrites = [];
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => 1500,
      set: (value) => scrollWrites.push(value)
    });
    const queuedRafs = [];
    const originalRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { queuedRafs.push(callback); return queuedRafs.length; };
    document.getElementById('btn-find').click();
    findInput.value = '目标词';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-find-expand').click();
    replaceInput.value = '已替换';
    // 输入即跳转的定位滚动发生在拦截安装之前已同步完成；此处再清一次记录，
    // 只观察“全部替换”本身是否发出滚动指令（发出即位置丢失）。
    scrollWrites.length = 0;
    document.getElementById('btn-replace-all').click();
    // 手动执行排队的 rAF（真实窗口由帧调度执行）
    while (queuedRafs.length) queuedRafs.shift()(performance.now());
    window.requestAnimationFrame = originalRaf;
    rootResults.replaceAllScrollWrites = scrollWrites.join(',');
    rootResults.replaceAllKeptScroll = scrollWrites.every((value) => value === 1500);
    delete scroller.scrollTop; // 移除属性拦截，恢复原型访问器
    document.getElementById('btn-find-close').click();

    // —— 回归：源码模式查找导航必须落在源码编辑器，而非右侧预览 ——
    window.editor.changeMode('markdown');
    await wait(150);
    window.editor.setMarkdown('alpha 一\\n\\nalpha 二\\n\\n正文', false);
    document.getElementById('btn-find').click();
    findInput.value = 'alpha';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-find-next').click();
    await wait(80);
    // 新查找机制用 CSS Custom Highlight 标记命中，不占用 DOM 选区；
    // 用高亮 Range 的容器判断命中落在源码编辑器还是右侧预览。
    const mdHighlight = [...(CSS.highlights.get('search-current') || [])][0];
    const mdHighlightElement = mdHighlight && mdHighlight.startContainer.nodeType === Node.ELEMENT_NODE
      ? mdHighlight.startContainer
      : mdHighlight && mdHighlight.startContainer.parentElement;
    rootResults.mdFindCounter = document.getElementById('find-count').textContent;
    rootResults.mdFindAnchorInPreview = Boolean(mdHighlightElement && mdHighlightElement.closest('.toastui-editor-md-preview'));
    rootResults.mdFindAnchorInSource = Boolean(mdHighlightElement && mdHighlightElement.closest('.ProseMirror'));
    document.getElementById('btn-find-next').click();
    await wait(80);
    rootResults.mdFindCounter2 = document.getElementById('find-count').textContent;

    // —— 回归：编辑器内按 Escape 关闭查找面板 ——
    document.querySelector('.toastui-editor')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(50);
    rootResults.escapeClosesFind = document.getElementById('find-panel').hidden;

    // —— 回归：光标位置（源码模式显示 [行,列]） ——
    window.editor.setMarkdown('L1\\nL2\\nL3\\nL4\\n第五行内容', false);
    window.editor.setSelection([5, 1], [5, 1]);
    window.editor.focus();
    await wait(150);
    rootResults.cursorMd = document.getElementById('cursor-pos').textContent;

    // —— 回归：查找框聚焦时清空误导性的光标位置 ——
    document.getElementById('btn-find').click();
    findInput.focus();
    await wait(100);
    rootResults.cursorClearedOnBlur = document.getElementById('cursor-pos').textContent === '';

    // —— 回归：所见即所得模式光标位置（块行号 + 块内列号） ——
    document.getElementById('btn-find-close').click();
    window.editor.changeMode('wysiwyg');
    await wait(150);
    window.editor.setMarkdown('段落一\\n\\n段落二内容', false);
    const wwView = window.editor.getCurrentModeEditor().view;
    let targetPos = 1;
    wwView.state.doc.descendants((node, pos) => {
      if (node.isText && node.text && node.text.indexOf('段落二内容') === 0) targetPos = pos + 2;
      return true;
    });
    window.editor.setSelection(targetPos, targetPos);
    window.editor.focus();
    await wait(150);
    // Toast UI 所见即所得模式中 markdown 空行会转换为真实可编辑的空段落，
    // 因此 '段落一\\n\\n段落二内容' 的第二段位于第 3 行。
    rootResults.cursorWw = document.getElementById('cursor-pos').textContent;

    // —— 回归 v1.3：大纲面板 ——
    window.editor.changeMode('markdown');
    await wait(200);
    window.editor.setMarkdown('# 一级\\n\\n正文\\n\\n## 二级A\\n\\n\`\`\`\\n# 围栏内不算\\n\`\`\`\\n\\n## 二级B', true);
    await wait(100);
    document.getElementById('tab-outline').click();
    await wait(450); // 300ms 防抖 + 余量
    rootResults.outlineCount = document.querySelectorAll('.outline-item').length;
    const outlineItems = document.querySelectorAll('.outline-item');
    rootResults.outlineFirstText = outlineItems[0]
      ? outlineItems[0].querySelector('.outline-text').textContent : '';
    rootResults.outlineFenceExcluded = Array.from(outlineItems).every((item) =>
      item.textContent.indexOf('围栏内不算') === -1);
    if (outlineItems[1]) outlineItems[1].click();
    await wait(120);
    rootResults.outlineJumpLine = window.editor.getSelection()[0][0]; // '## 二级A' 在第 5 行
    rootResults.outlineActiveIndex = document.querySelector('.outline-item.active')
      ? document.querySelector('.outline-item.active').dataset.index : '';

    // —— 回归 v1.3：所见即所得模式大纲跳转 ——
    window.editor.changeMode('wysiwyg');
    await wait(250);
    const wwOutlineItems = document.querySelectorAll('.outline-item');
    if (wwOutlineItems[1]) wwOutlineItems[1].click();
    await wait(120);
    const wwOutlineSelection = window.editor.getSelection()[0];
    rootResults.outlineWwJump = typeof wwOutlineSelection === 'number' && wwOutlineSelection > 0;
    document.getElementById('tab-files').click();

    // —— 回归：查找跳转必须把匹配位置滚进可视区（不依赖编辑器焦点） ——
    window.editor.changeMode('wysiwyg');
    await wait(150);
    const jumpParas = [];
    for (let i = 0; i < 200; i += 1) jumpParas.push('段落' + i + ' 普通填充内容');
    jumpParas.push('末尾段落 needleMarker 在这里');
    window.editor.setMarkdown(jumpParas.join('\\n\\n'), false);
    await wait(250);
    document.getElementById('btn-find').click();
    findInput.value = 'needleMarker';
    // 隐藏窗口冻结真实滚动，用属性拦截验证滚动指令已发出。
    // 输入即跳转：拦截需在 input 事件之前安装，才能捕获首次定位的大幅滚动。
    const jumpScroller = Array.from(document.querySelectorAll('.toastui-editor .ProseMirror'))
      .find((el) => el.offsetParent !== null);
    const jumpWrites = [];
    Object.defineProperty(jumpScroller, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (v) => jumpWrites.push(Math.round(v))
    });
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);
    document.getElementById('btn-find-next').click();
    await wait(150);
    delete jumpScroller.scrollTop;
    rootResults.findJumpWrites = jumpWrites.length;
    rootResults.findScrolled = jumpWrites.some((v) => v > 1000);
    rootResults.findHighlightActive = CSS.highlights.has('search-current');
    document.getElementById('btn-find-close').click();

    // —— 回归 v1.4：代码块复制按钮（悬浮式，mouseover 定位到 ww 代码块） ——
    window.editor.setMarkdown('\`\`\`js\\nconst answer = 42;\\n\`\`\`', false);
    await wait(300);
    let copyButton = null;
    const copyPre = document.querySelector('.toastui-editor-ww-container pre');
    // 悬浮按钮在任何滚动事件后都会先隐藏（fixed 定位失准防护），
    // 断言需在 mouseover 派发后同步读取，避免与延迟滚动事件竞态。
    if (copyPre) copyPre.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    copyButton = document.querySelector('.code-block-copy-btn.visible');
    rootResults.copyButtonMounted = Boolean(copyButton);
    rootResults.copyPreCount = document.querySelectorAll('.toastui-editor-ww-container pre').length;
    rootResults.copyButtonCount = document.querySelectorAll('.code-block-copy-btn').length;
    if (copyButton) copyButton.click();
    await wait(150);
    rootResults.copyButtonFeedback = copyButton ? copyButton.textContent : 'no-button';

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

    const mermaidMarkdown = [
      '\`\`\`mermaid',
      'flowchart LR',
      'A[24V J1] --> B[DC_LINK]',
      '\`\`\`',
      '',
      '\`\`\`markup',
      'flowchart LR',
      'C[兼容旧文档] --> D[完成渲染]',
      '\`\`\`',
      '',
      '渲染后的正文'
    ].join('\\n');
    window.editor.setMarkdown(mermaidMarkdown, false);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelectorAll('.toastui-editor-md-preview .mermaid-diagram svg').length === 2) break;
      await wait(100);
    }
    const mermaidState = {
      sourcePreviewSvgCount: document.querySelectorAll(
        '.toastui-editor-md-preview .mermaid-diagram svg'
      ).length
    };
    window.editor.changeMode('wysiwyg');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelectorAll(
        '.mermaid-wysiwyg-preview[data-mermaid-rendered="true"]'
      ).length === 2) break;
      await wait(100);
    }
    Object.assign(mermaidState, {
      svgCount: Array.from(
        document.querySelectorAll('.mermaid-wysiwyg-preview[data-mermaid-rendered="true"]')
      ).filter((element) => element.querySelector('svg')).length,
      visiblePreviewCount: Array.from(
        document.querySelectorAll('.mermaid-wysiwyg-preview[data-mermaid-rendered="true"]')
      ).filter((element) => {
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + Math.min(12, rect.width / 2),
          rect.top + Math.min(12, rect.height / 2)
        );
        return topElement === element || element.contains(topElement);
      }).length,
      sourceCodeCount: document.querySelectorAll(
        '.toastui-editor-ww-code-block-highlighting > pre code'
      ).length,
      wrapperContainsSvg: Array.from(document.querySelectorAll('.mermaid-wysiwyg-preview svg'))
        .every((svg) => svg.closest('.mermaid-wysiwyg-code-block')?.contains(svg)),
      aspectRatioStable: Array.from(
        document.querySelectorAll('.mermaid-wysiwyg-preview svg')
      ).every((svg) => {
        const box = svg.viewBox.baseVal;
        const rect = svg.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && rect.width > 0 && rect.height > 0 &&
          Math.abs(rect.width / rect.height - box.width / box.height) < 0.02;
      }),
      followingContentNotCovered: (() => {
        const paragraph = Array.from(document.querySelectorAll('.toastui-editor-ww-container .ProseMirror p'))
          .find((element) => element.textContent === '渲染后的正文');
        const bottom = Math.max(...Array.from(document.querySelectorAll('.mermaid-wysiwyg-preview'), (element) =>
          element.getBoundingClientRect().bottom
        ));
        return Boolean(paragraph) && paragraph.getBoundingClientRect().top >= bottom - 1;
      })(),
      markdown: window.editor.getMarkdown()
    });
    window.editor.changeMode('markdown');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelectorAll('.toastui-editor-md-preview .mermaid-diagram svg').length === 2) break;
      await wait(100);
    }
    mermaidState.previewSvgCount = document.querySelectorAll(
      '.toastui-editor-md-preview .mermaid-diagram svg'
    ).length;

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
      mermaidState,
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
  if (
    state.mermaidState.svgCount !== 2 ||
    state.mermaidState.visiblePreviewCount !== 2 ||
    !state.mermaidState.wrapperContainsSvg ||
    !state.mermaidState.aspectRatioStable ||
    !state.mermaidState.followingContentNotCovered ||
    state.mermaidState.sourcePreviewSvgCount !== 2 ||
    state.mermaidState.previewSvgCount !== 2 ||
    state.mermaidState.sourceCodeCount !== 2 ||
    !/```mermaid[\s\S]*A\[24V J1\] --> B\[DC_LINK\]/.test(state.mermaidState.markdown) ||
    !/```markup[\s\S]*C\[兼容旧文档\] --> D\[完成渲染\]/.test(state.mermaidState.markdown)
  ) {
    finish(new Error(`Mermaid rendering regression: ${JSON.stringify(state.mermaidState)}`));
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
    root.findLiveJump !== '1/2' ||
    root.findCount !== '2/2' ||
    root.replaced !== '查找 beta，再次 beta' ||
    root.modeBefore === root.modeAfter ||
    root.sidebarBefore === root.sidebarAfter ||
    root.sidebarExpanded !== String(root.sidebarBefore) ||
    !/^## 内容/m.test(root.markdownModeHeading)
  ) {
    finish(new Error(`Context menu clipboard regression: ${JSON.stringify(root)}`));
    return;
  }

  // —— 回归：本轮 UX/稳定性修复 ——
  // 缩放百分比：Electron 缩放因子为 1.2^level，level 1 必须显示 120%。
  window.webContents.send('zoom:levelChanged', 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const zoomText = await window.webContents.executeJavaScript(
    `document.getElementById('zoom-level').textContent`
  );
  // v1.3：主题切换应写入偏好补丁；导出命令应携带 markdown 快照到达主进程。
  root.themePrefPatchReceived = prefPatches.some((patch) => patch && patch.theme === 'dark');
  window.webContents.send('editor:command', 'export', { format: 'pdf' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  root.exportWired = exportCalls.length === 1 && exportCalls[0].format === 'pdf' &&
    exportCalls[0].markdownIsString === true;

  // v1.4：字号/字体命令 → CSS 变量 + 偏好补丁
  window.webContents.send('editor:command', 'setFontSize', { size: 20 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  root.fontSizeVar = await window.webContents.executeJavaScript(
    `document.documentElement.style.getPropertyValue('--md-reader-font-size')`);
  window.webContents.send('editor:command', 'setFontFamily', { family: 'mono' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  root.fontFamilyVar = await window.webContents.executeJavaScript(
    `document.documentElement.style.getPropertyValue('--md-reader-font-family')`);
  root.fontPrefPatches = prefPatches.some((p) => p && p.editorFontSize === 20) &&
    prefPatches.some((p) => p && p.editorFontFamily === 'mono');

  // v1.4：自动保存 + 备份写入（当前文档路径来自 system:openDocument 存根）
  window.webContents.send('editor:command', 'autoSaveChanged', { enabled: true });
  await window.webContents.executeJavaScript(`window.editor.setMarkdown('自动保存内容 v1.4', false)`);
  await new Promise((resolve) => setTimeout(resolve, 3200)); // 1s 备份 + 2s 自动保存
  root.backupWritten = backupWrites.some((s) => s && s.content === '自动保存内容 v1.4');
  root.autoSaved = autoSaves.some((s) => s.content === '自动保存内容 v1.4' && s.filePath === 'C:\\fixture\\关联打开.md');
  window.webContents.send('editor:command', 'autoSaveChanged', { enabled: false });
  root.clipboardText = clipboard.readText();

  const regressionWork =
    root.mdFindCounter === '2/2' &&
    root.mdFindCounter2 === '1/2' &&
    root.mdFindAnchorInPreview === false &&
    root.mdFindAnchorInSource === true &&
    root.escapeClosesFind === true &&
    root.cursorMd === '第5行 第1列' &&
    root.cursorClearedOnBlur === true &&
    root.cursorWw === '第3行 第3列' &&
    root.replaceAllKeptScroll === true &&
    root.themePrefPatchReceived === true &&
    root.exportWired === true &&
    root.outlineCount === 3 &&
    root.outlineFirstText === '一级' &&
    root.outlineFenceExcluded === true &&
    root.outlineJumpLine === 5 &&
    root.outlineActiveIndex === '1' &&
    root.outlineWwJump === true &&
    root.copyButtonMounted === true &&
    root.copyButtonFeedback === '已复制' &&
    root.clipboardText === 'const answer = 42;' &&
    root.findScrolled === true &&
    root.findHighlightActive === true &&
    root.fontSizeVar === '20px' &&
    root.fontFamilyVar === 'Consolas, "Courier New", monospace' &&
    root.fontPrefPatches === true &&
    root.backupWritten === true &&
    root.autoSaved === true &&
    zoomText === '120%';
  if (!regressionWork) {
    finish(new Error(`UX regression: ${JSON.stringify({ root, zoomText })}`));
    return;
  }

  console.log(`Electron renderer and context menus OK: ${state.title}`);
  finish();
}).catch(finish);
