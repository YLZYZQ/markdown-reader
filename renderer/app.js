// 渲染进程：基于 Toast UI Editor 的 Markdown 编辑器
'use strict';

// ============ DOM ============
const filenameEl = document.getElementById('filename');
const statusInfoEl = document.getElementById('status-info');
const wordCountEl = document.getElementById('word-count');
const cursorPosEl = document.getElementById('cursor-pos');
const zoomLevelEl = document.getElementById('zoom-level');
const themeIconEl = document.getElementById('theme-icon');
const dropOverlay = document.getElementById('drop-overlay');
const documentBaseEl = document.getElementById('document-base');
const modeButtonEl = document.getElementById('btn-mode');
const findPanelEl = document.getElementById('find-panel');
const findInputEl = document.getElementById('find-input');
const replaceInputEl = document.getElementById('replace-input');
const findCountEl = document.getElementById('find-count');
const caseSensitiveEl = document.getElementById('find-case-sensitive');
const workspaceEl = document.getElementById('workspace');
const fileTreeEl = document.getElementById('file-tree');
const sidebarRootEl = document.getElementById('sidebar-root');
const sidebarButtonEl = document.getElementById('btn-sidebar');
const sidebarRefreshButtonEl = document.getElementById('btn-sidebar-refresh');
const tabFilesEl = document.getElementById('tab-files');
const tabOutlineEl = document.getElementById('tab-outline');
const outlinePanelEl = document.getElementById('outline-panel');
const outlineListEl = document.getElementById('outline-list');

// 后续会把 <base> 指向当前文档目录；先固定应用自身样式资源的绝对地址。
document.querySelectorAll('link[href]').forEach((link) => link.setAttribute('href', link.href));

// ============ 状态 ============
let editor = null;
window.editor = null;
let currentFilePath = null;
let currentBaseUrl = null;
let isDirty = false;
let lastSavedContent = '';
let currentTheme = 'light';
let followsSystemTheme = true;
let currentEditMode = 'wysiwyg';
let currentFindMatch = -1;
let lastFindSignature = '';
let fileTreeRequestId = 0;
let sidebarCollapsed = false;
let pendingSystemDocumentPath = null;
let autoSaveEnabled = false;
let autoSaveTimer = null;
let backupTimer = null;
let saveInFlight = false;
let editorFontPrefs = { size: 16, family: '' };
try {
  sidebarCollapsed = localStorage.getItem('md-reader.sidebarCollapsed') === 'true';
} catch (error) {
  console.warn('无法读取侧边栏状态:', error);
}

// Toast UI Editor 实例（UMD 全局）
const Editor = toastui.Editor;
const codeSyntaxHighlight = window.toastuiEditorBundle.codeSyntaxHighlight;
const mermaid = window.toastuiEditorBundle.mermaid;
let mermaidRenderScheduled = false;
let mermaidRenderRunning = false;
let mermaidRenderRequested = false;
let mermaidDiagramId = 0;

class MermaidCodeBlockView {
  constructor(node) {
    this.node = node;
    this.renderToken = 0;
    this.createElement();
    this.render();
  }

  createElement() {
    const language = this.node.attrs.language || 'mermaid';
    const wrapper = document.createElement('div');
    wrapper.className = 'toastui-editor-ww-code-block-highlighting mermaid-wysiwyg-code-block';
    wrapper.setAttribute('data-language', language);

    const pre = document.createElement('pre');
    pre.className = `language-${language}`;
    const code = document.createElement('code');
    code.setAttribute('data-language', language);
    pre.appendChild(code);

    const preview = document.createElement('div');
    preview.className = 'mermaid-wysiwyg-preview';
    preview.setAttribute('contenteditable', 'false');
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', 'Mermaid 图表');

    wrapper.append(pre, preview);
    this.dom = wrapper;
    this.contentDOM = code;
    this.preview = preview;
  }

  async render() {
    const source = this.node.textContent;
    const token = ++this.renderToken;
    this.preview.replaceChildren();
    this.preview.dataset.mermaidRendering = 'true';
    try {
      window.configureMermaid(mermaid, currentTheme);
      const { svg, bindFunctions } = await mermaid.render(`mermaid-wysiwyg-${++mermaidDiagramId}`, source);
      if (token !== this.renderToken || !this.preview.isConnected) return;
      this.preview.innerHTML = svg;
      this.preview.dataset.mermaidRendered = 'true';
      this.preview.removeAttribute('data-mermaid-rendering');
      this.preview.removeAttribute('data-mermaid-error');
      if (bindFunctions) bindFunctions(this.preview);
    } catch (error) {
      if (token !== this.renderToken || !this.preview.isConnected) return;
      this.preview.textContent = `Mermaid 图表语法错误\n${source}`;
      this.preview.dataset.mermaidRendered = 'true';
      this.preview.dataset.mermaidError = 'true';
      this.preview.removeAttribute('data-mermaid-rendering');
      console.warn('Mermaid 图表渲染失败:', error);
    }
  }

  update(node) {
    if (!node.sameMarkup(this.node)) return false;
    const changed = node.textContent !== this.node.textContent;
    this.node = node;
    if (changed) this.render();
    return true;
  }

  stopEvent() { return true; }

  ignoreMutation(mutation) {
    const target = mutation.target.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target.parentElement;
    // ProseMirror 只需要观察 contentDOM 的源码文本；SVG 异步插入是 NodeView
    // 自己的展示状态，不能据此重建整个代码块。
    return Boolean(target && !this.contentDOM.contains(target));
  }

  destroy() { this.renderToken += 1; }
}

function mermaidCodeSyntaxHighlight(context) {
  const baseInfo = codeSyntaxHighlight(context);
  const baseCodeBlockView = baseInfo.wysiwygNodeViews.codeBlock;
  return {
    ...baseInfo,
    wysiwygNodeViews: {
      ...baseInfo.wysiwygNodeViews,
      codeBlock(node, view, getPos, eventEmitter) {
        const language = (node.attrs.language || '').trim().split(/\s+/, 1)[0].toLowerCase();
        return isMermaidSource(language, node.textContent)
          ? new MermaidCodeBlockView(node, view, getPos, eventEmitter)
          : baseCodeBlockView(node, view, getPos, eventEmitter);
      }
    }
  };
}

async function renderMermaidDiagrams() {
  if (mermaidRenderRunning) {
    mermaidRenderRequested = true;
    return;
  }

  const diagrams = Array.from(document.querySelectorAll(
    '.toastui-editor-md-preview .mermaid-diagram:not([data-mermaid-rendered])'
  ));
  if (!diagrams.length) return;

  mermaidRenderRunning = true;
  for (const diagram of diagrams) {
    if (!diagram.isConnected || diagram.dataset.mermaidRendering === 'true') continue;
    await window.renderMermaidInto(diagram, mermaid, `mermaid-diagram-${++mermaidDiagramId}`, currentTheme);
  }
  mermaidRenderRunning = false;

  if (mermaidRenderRequested) {
    mermaidRenderRequested = false;
    scheduleMermaidRender();
  }
}

function scheduleMermaidRender() {
  if (mermaidRenderScheduled) return;
  mermaidRenderScheduled = true;
  setTimeout(() => {
    mermaidRenderScheduled = false;
    void renderMermaidDiagrams();
  }, 0);
}

const mermaidDOMObserver = new MutationObserver(scheduleMermaidRender);

window.api.onSystemOpenDocument((filePath) => {
  if (!editor) {
    pendingSystemDocumentPath = filePath;
    return;
  }
  void openSystemDocument(filePath);
});

// ============ 主题 ============
function applyTheme(theme, fromSystem = false) {
  if (fromSystem && !followsSystemTheme) return;
  const themeChanged = theme !== currentTheme;
  currentTheme = theme;
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-light', theme === 'light');
  themeIconEl.textContent = theme === 'dark' ? '☀️' : '🌙';
  themeIconEl.parentElement.title =
    `切换主题 (当前: ${theme === 'dark' ? '暗色' : '亮色'}${fromSystem ? '，跟随系统' : ''})`;
  // Toast UI 主题：重建编辑器（官方推荐方式）。主题值未变化时跳过，
  // 避免系统主题通知触发不必要的重建（闪屏 + 丢失选区）。
  if (themeChanged || !editor) rebuildEditor();
}

function toggleTheme() {
  followsSystemTheme = false;
  const next = currentTheme === 'dark' ? 'light' : 'dark';
  window.api.setPreference({ theme: next });
  applyTheme(next);
}

async function followSystemTheme() {
  followsSystemTheme = true;
  try {
    const sys = await window.api.getSystemTheme();
    window.api.setPreference({ theme: 'system' });
    applyTheme(sys, true);
    setStatus(sys === 'dark' ? '已切换为跟随系统（当前暗色）' : '已切换为跟随系统（当前亮色）');
  } catch (_) {
    toast('无法读取系统主题');
  }
}

function updateEditMode(mode) {
  currentEditMode = mode === 'markdown' ? 'markdown' : 'wysiwyg';
  const isMarkdown = currentEditMode === 'markdown';
  modeButtonEl.textContent = isMarkdown ? '所见即所得' : '源码';
  modeButtonEl.title = isMarkdown
    ? '切换到所见即所得模式 (Ctrl+/)'
    : '切换到源码模式 (Ctrl+/)';
  setStatus(isMarkdown ? 'Markdown 源码模式' : '所见即所得模式');
}

function toggleEditMode() {
  const nextMode = currentEditMode === 'wysiwyg' ? 'markdown' : 'wysiwyg';
  editor.changeMode(nextMode);
  updateEditMode(nextMode);
}

// ============ 编辑器初始化 ============
function createEditor(initialValue) {
  let instance = null;
  instance = new Editor({
    el: document.getElementById('editor'),
    height: '100%',
    initialEditType: currentEditMode,
    previewStyle: 'vertical',
    hideModeSwitch: true,            // 隐藏模式切换 tab
    usageStatistics: false,          // ★ 关闭 GA 统计（离线必须）
    language: 'zh-CN',               // 中文界面
    theme: currentTheme,
    initialValue: initialValue,
    plugins: [mermaidCodeSyntaxHighlight],  // Mermaid NodeView + 其他代码块 Prism 高亮
    customHTMLRenderer: window.createMermaidHtmlRenderer(),
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['hr', 'quote'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'image', 'link'],
      ['code', 'codeblock'],
    ],
    hooks: {
      // 图片插入：存到本地 + 相对路径
      addImageBlobHook: async (blob, callback) => {
        await handleImageInsert(blob, callback);
      }
    },
    events: {
      change: () => {
        if (!instance) return;
        const md = instance.getMarkdown();
        updateWordCount(md);
        setDirty(md !== lastSavedContent);
        if (!findPanelEl.hidden) updateFindCount();
        scheduleMermaidRender();
        scheduleOutlineRefresh();
        scheduleSessionBackup();
        scheduleAutoSave();
      },
      changeMode: (mode) => {
        updateEditMode(mode);
        updateCaretStatus();
        scheduleMermaidRender();
        hideMatchHighlight();
        // Toast UI 在 changeMode 通知后仍会完成一次 code-block NodeView 更新。
        setTimeout(scheduleMermaidRender, 80);
      }
    }
  });
  instance.on('afterPreviewRender', scheduleMermaidRender);
  // 光标事件统一走 instance.on：构造函数 events 选项不转发 focus/blur/caretChange。
  instance.on('caretChange', updateCaretStatus);
  instance.on('focus', updateCaretStatus);
  instance.on('blur', () => updateCursorPos(null));
  scheduleMermaidRender();
  return instance;
}

// 兜底：源码模式的 ProseMirror 不总触发 Toast UI blur 事件，
// 任何焦点离开编辑区的时机都重新校验一次光标显示。
function watchEditorFocusLoss() {
  document.addEventListener('focusout', () => {
    setTimeout(updateCaretStatus, 0);
  });
}

// 重建编辑器（用于切换主题）
function rebuildEditor() {
  if (!editor) return;
  const md = editor.getMarkdown();
  const scroll = captureEditorScroll();
  const wasDirty = isDirty;
  let selection = null;
  try {
    selection = editor.getSelection();
  } catch (_) { /* 选区不可读时跳过恢复 */ }
  editor.destroy();
  editor = createEditor(md);
  window.editor = editor;
  setDirty(wasDirty);
  hideMatchHighlight();
  if (selection) {
    try {
      // getSelection/setSelection 在同一模式下格式一致（源码 [行,列]，所见即所得偏移量）。
      editor.setSelection(selection[0], selection[1]);
    } catch (_) { /* 位置失效则放弃恢复 */ }
  }
  restoreEditorScroll(scroll);
}

// ============ 状态更新 ============
function setDirty(dirty) {
  const nextDirty = Boolean(dirty);
  const changed = isDirty !== nextDirty;
  isDirty = nextDirty;
  filenameEl.classList.toggle('dirty', dirty);
  updateTitle();
  if (changed) window.api.setDocumentDirty(isDirty);
}

function updateTitle() {
  const name = currentFilePath ? baseName(currentFilePath) : '未命名.md';
  filenameEl.textContent = name;
  document.title = `${isDirty ? '• ' : ''}${name} - Markdown阅读器`;
}

function setDocumentBase(baseUrl) {
  currentBaseUrl = baseUrl || null;
  documentBaseEl.href = baseUrl || './';
}

function baseName(p) {
  return p.replace(/\\/g, '/').split('/').pop();
}

function comparablePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLocaleLowerCase();
}

function setSidebarCollapsed(collapsed, persist = true) {
  sidebarCollapsed = Boolean(collapsed);
  workspaceEl.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  sidebarButtonEl.setAttribute('aria-expanded', String(!sidebarCollapsed));
  sidebarButtonEl.title = `${sidebarCollapsed ? '显示' : '隐藏'}文件侧边栏 (Ctrl+Shift+E)`;
  if (persist) {
    try {
      localStorage.setItem('md-reader.sidebarCollapsed', String(sidebarCollapsed));
    } catch (error) {
      console.warn('无法保存侧边栏状态:', error);
    }
  }
}

function clearFileTree(message = '打开或保存文档后，将显示同目录下的文件。') {
  fileTreeEl.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'sidebar-empty';
  empty.textContent = message;
  fileTreeEl.appendChild(empty);
  sidebarRootEl.textContent = '尚未打开文档';
  sidebarRootEl.title = '尚未打开文档';
}

function treeEntryContainsPath(entry, targetPath) {
  if (entry.type === 'file') return comparablePath(entry.path) === targetPath;
  return entry.children.some((child) => treeEntryContainsPath(child, targetPath));
}

function createTreeEntry(entry, activePath) {
  if (entry.type === 'directory') {
    const details = document.createElement('details');
    details.className = 'tree-directory';
    details.open = entry.children.some((child) => treeEntryContainsPath(child, activePath));

    const summary = document.createElement('summary');
    summary.title = entry.path;
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '📁';
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;
    summary.append(icon, name);
    details.appendChild(summary);

    const children = document.createElement('div');
    children.className = 'tree-children';
    entry.children.forEach((child) => children.appendChild(createTreeEntry(child, activePath)));
    details.appendChild(children);
    return details;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tree-file';
  button.classList.toggle('active', comparablePath(entry.path) === activePath);
  button.title = entry.path;
  button.dataset.filePath = entry.path;

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = '📄';
  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;
  button.append(icon, name);
  button.addEventListener('click', () => void openDocumentFromSidebar(entry.path));
  return button;
}

async function refreshFileTree(filePath = currentFilePath) {
  if (!filePath) {
    fileTreeRequestId += 1;
    clearFileTree();
    return;
  }

  const requestId = ++fileTreeRequestId;
  sidebarRefreshButtonEl.classList.add('loading');
  try {
    const result = await window.api.listDirectoryForDocument(filePath);
    if (requestId !== fileTreeRequestId) return;
    if (result.error) {
      clearFileTree('无法读取当前文档目录：' + result.error);
      return;
    }

    sidebarRootEl.textContent = result.rootName;
    sidebarRootEl.title = result.rootPath;
    fileTreeEl.replaceChildren();
    const activePath = comparablePath(currentFilePath);
    result.entries.forEach((entry) => fileTreeEl.appendChild(createTreeEntry(entry, activePath)));

    if (result.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = '当前目录下没有 Markdown 或文本文件。';
      fileTreeEl.appendChild(empty);
    } else if (result.truncated) {
      const notice = document.createElement('div');
      notice.className = 'sidebar-empty';
      notice.textContent = '目录内容较多，已限制显示范围。';
      fileTreeEl.appendChild(notice);
    }
  } catch (error) {
    if (requestId === fileTreeRequestId) clearFileTree('无法读取当前文档目录：' + error.message);
  } finally {
    if (requestId === fileTreeRequestId) sidebarRefreshButtonEl.classList.remove('loading');
  }
}

async function openDocumentFromSidebar(filePath) {
  if (comparablePath(filePath) === comparablePath(currentFilePath)) return;
  if (!(await confirmBeforeReplace())) return;
  try {
    const result = await window.api.openPath(filePath);
    if (result.error) {
      toast('打开失败: ' + result.error);
      void refreshFileTree();
      return;
    }
    loadContent(result.filePath, result.content, result.baseUrl);
  } catch (error) {
    toast('打开失败: ' + error.message);
  }
}

// ============ 大纲面板 ============
let outlineEntries = [];
let outlineRefreshTimer = null;

function setSidebarTab(tab) {
  const isOutline = tab === 'outline';
  tabFilesEl.classList.toggle('active', !isOutline);
  tabOutlineEl.classList.toggle('active', isOutline);
  tabFilesEl.setAttribute('aria-selected', String(!isOutline));
  tabOutlineEl.setAttribute('aria-selected', String(isOutline));
  fileTreeEl.hidden = isOutline;
  outlinePanelEl.hidden = !isOutline;
  if (isOutline) rebuildOutline();
}

function scheduleOutlineRefresh() {
  if (outlinePanelEl.hidden) return;
  if (outlineRefreshTimer) clearTimeout(outlineRefreshTimer);
  outlineRefreshTimer = setTimeout(() => {
    outlineRefreshTimer = null;
    rebuildOutline();
  }, 300);
}

function rebuildOutline() {
  if (!editor) return;
  const listScrollTop = outlineListEl.scrollTop;
  outlineEntries = extractOutline(editor.getMarkdown());
  outlineListEl.replaceChildren();
  if (!outlineEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = '当前文档没有标题。';
    outlineListEl.appendChild(empty);
    return;
  }
  outlineEntries.forEach((entry, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.style.paddingLeft = `${8 + (entry.level - 1) * 12}px`;
    button.title = entry.text;
    button.dataset.index = String(index);
    const label = document.createElement('span');
    label.className = 'outline-text';
    label.textContent = entry.text;
    const level = document.createElement('span');
    level.className = 'outline-level';
    level.textContent = `H${entry.level}`;
    button.append(label, level);
    button.addEventListener('click', () => jumpToHeading(index));
    outlineListEl.appendChild(button);
  });
  outlineListEl.scrollTop = listScrollTop;
  updateOutlineActive();
}

function jumpToHeading(index) {
  const entry = outlineEntries[index];
  if (!entry) return;
  if (currentEditMode === 'markdown') {
    // 源码模式 setSelection 使用 1-based [行, 列]。
    editor.setSelection([entry.line, 1], [entry.line, 1]);
  } else {
    const pos = wwHeadingPosition(index);
    if (pos === null) {
      toast('该标题无法在当前视图定位，请切换到源码模式');
      return;
    }
    editor.setSelection(pos, pos);
  }
  editor.focus();
  scrollEditorSelectionIntoView();
}

// 所见即所得模式的 heading 节点按文档序与 markdown 标题一一对应。
function wwHeadingPositions() {
  const positions = [];
  try {
    const view = editor.getCurrentModeEditor().view;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') positions.push({ pos: pos + 1, text: node.textContent });
      return true;
    });
  } catch (_) { /* 视图不可用 */ }
  return positions;
}

function wwHeadingPosition(index) {
  const entry = outlineEntries[index];
  if (!entry) return null;
  const headings = wwHeadingPositions();
  if (headings.length === outlineEntries.length) {
    return headings[index] ? headings[index].pos : null;
  }
  const byText = headings.find((heading) => heading.text === entry.text);
  return byText ? byText.pos : null;
}

// 光标移动时高亮当前所属章节标题。
function updateOutlineActive() {
  if (outlinePanelEl.hidden || !outlineEntries.length) return;
  let activeIndex = -1;
  try {
    if (currentEditMode === 'markdown') {
      const line = editor.getSelection()[0][0];
      for (let index = 0; index < outlineEntries.length; index += 1) {
        if (outlineEntries[index].line <= line) activeIndex = index;
        else break;
      }
    } else {
      const view = editor.getCurrentModeEditor().view;
      const offset = Math.max(0, Math.min(editor.getSelection()[0], view.state.doc.content.size));
      const childIndex = view.state.doc.resolve(offset).index(0);
      let headingCount = 0;
      view.state.doc.forEach((node, _offset, index) => {
        if (index <= childIndex && node.type.name === 'heading') headingCount += 1;
      });
      activeIndex = headingCount - 1;
    }
  } catch (_) {
    return;
  }
  outlineListEl.querySelectorAll('.outline-item.active').forEach((el) => el.classList.remove('active'));
  if (activeIndex >= 0 && activeIndex < outlineEntries.length) {
    const item = outlineListEl.querySelector(`.outline-item[data-index="${activeIndex}"]`);
    if (item) {
      item.classList.add('active');
      const itemRect = item.getBoundingClientRect();
      const listRect = outlineListEl.getBoundingClientRect();
      if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }
}

function setStatus(text) {
  statusInfoEl.textContent = text;
}

function updateWordCount(md) {
  const text = (md || '').replace(/[#*`>\-_\[\]()!|=\s]/g, '');
  wordCountEl.textContent = `${text.length} 字`;
}

function updateCursorPos(pos) {
  if (!cursorPosEl) return;
  if (!pos) { cursorPosEl.textContent = ''; return; }
  const { line, col } = pos;
  cursorPosEl.textContent = `第${line}行 第${col}列`;
}

function updateZoomLevel(level) {
  if (!zoomLevelEl) return;
  // Electron 缩放因子 = 1.2^zoomLevel（zoomLevel 为对数刻度）。
  const factor = Math.round(Math.pow(1.2, Number(level) || 0) * 100);
  zoomLevelEl.textContent = `${factor}%`;
}

// 通过 Toast UI caretChange 事件追踪光标位置（编辑器聚焦时才显示）。
function getCaretPosition() {
  try {
    const selection = editor.getSelection();
    if (currentEditMode === 'markdown') {
      // 源码模式：getSelection 返回 1-based [行, 列] 位置对。
      const start = selection[0];
      if (!Array.isArray(start)) return null;
      return { line: start[0], col: start[1] };
    }
    // 所见即所得模式：getSelection 返回文档偏移量，用 ProseMirror 状态
    // 换算为“块序号 + 块内列号”，与用户感知的行/列一致。
    const view = editor.getCurrentModeEditor().view;
    const offset = Math.max(0, Math.min(selection[0], view.state.doc.content.size));
    const $from = view.state.doc.resolve(offset);
    return { line: $from.index(0) + 1, col: $from.parentOffset + 1 };
  } catch (_) {
    return null;
  }
}

function updateCaretStatus() {
  let focused = false;
  try {
    focused = editor.getCurrentModeEditor().view.hasFocus();
  } catch (_) { /* 编辑器尚未就绪 */ }
  updateCursorPos(focused ? getCaretPosition() : null);
  updateOutlineActive();
}

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// ============ 文件操作 ============
async function confirmBeforeReplace() {
  if (!isDirty) return true;
  try {
    const choice = await window.api.confirmReplace();
    if (choice === 'discard') return true;
    if (choice === 'save') return saveFile(false);
  } catch (error) {
    toast('无法确认未保存更改: ' + error.message);
  }
  return false;
}

async function newDocument() {
  if (!(await confirmBeforeReplace())) return false;
  currentFilePath = null;
  fileTreeRequestId += 1;
  lastSavedContent = '';
  setDocumentBase(null);
  clearFileTree();
  editor.setMarkdown('', false);
  findPanelEl.hidden = true;
  setDirty(false);
  updateTitle();
  updateWordCount('');
  setStatus('已新建空白文档');
  toast('已新建文档');
  window.api.stopWatchingDocument();
  discardSessionBackup();
  editor.focus();
  return true;
}

async function openFile() {
  try {
    const res = await window.api.openFile();
    if (res.canceled) return;
    if (res.error) { toast('打开失败: ' + res.error); return; }
    if (!(await confirmBeforeReplace())) return;
    loadContent(res.filePath, res.content, res.baseUrl);
  } catch (error) {
    toast('打开失败: ' + error.message);
  }
}

async function openSystemDocument(filePath) {
  if (!filePath || comparablePath(filePath) === comparablePath(currentFilePath)) return;
  if (!(await confirmBeforeReplace())) return;
  try {
    const result = await window.api.openPath(filePath);
    if (result.error) {
      toast('打开失败: ' + result.error);
      return;
    }
    loadContent(result.filePath, result.content, result.baseUrl);
  } catch (error) {
    toast('打开失败: ' + error.message);
  }
}

function loadContent(filePath, content, baseUrl) {
  currentFilePath = filePath || null;
  setDocumentBase(baseUrl);
  editor.setMarkdown(content, false);
  // Toast UI 可能规范化末尾换行；以编辑器实际内容作为已保存基线，避免刚打开就误报修改。
  lastSavedContent = editor.getMarkdown();
  findPanelEl.hidden = true;
  setDirty(false);
  updateTitle();
  const displayName = filePath ? baseName(filePath) : '未命名.md';
  setStatus('已打开: ' + displayName);
  if (filePath) {
    toast('已打开 ' + displayName);
    void refreshFileTree(filePath);
  }
}

// ============ 崩溃恢复备份与自动保存 ============
// 内容变更 1 秒防抖写入备份（始终开启）；自动保存（可选）2 秒防抖静默保存。
function scheduleSessionBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    try {
      window.api.writeBackup({
        filePath: currentFilePath,
        baseUrl: currentBaseUrl,
        content: editor.getMarkdown(),
        savedAt: Date.now(),
      });
    } catch (_) { /* 备份失败不影响编辑 */ }
  }, 1000);
}

function discardSessionBackup() {
  if (backupTimer) { clearTimeout(backupTimer); backupTimer = null; }
  try {
    window.api.clearBackup();
  } catch (_) { /* 忽略 */ }
}

function setAutoSaveEnabled(enabled) {
  autoSaveEnabled = Boolean(enabled);
  if (!autoSaveEnabled && autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

function scheduleAutoSave() {
  if (!autoSaveEnabled || !currentFilePath || !isDirty) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    if (autoSaveEnabled && currentFilePath && isDirty && !saveInFlight) {
      void saveFile(false, { silent: true });
    }
  }, 2000);
}

async function saveFile(saveAs = false, options = {}) {
  if (saveInFlight) return false;
  saveInFlight = true;
  try {
    const content = editor.getMarkdown();
    const target = saveAs ? null : currentFilePath;
    const res = await window.api.saveFile(target, content);
    if (res.canceled) return false;
    if (res.error) { toast('保存失败: ' + res.error); return false; }
    currentFilePath = res.filePath;
    lastSavedContent = content;
    setDocumentBase(res.baseUrl);
    setDirty(false);
    updateTitle();
    discardSessionBackup();
    if (options.silent) {
      setStatus('已自动保存: ' + baseName(currentFilePath));
    } else {
      setStatus('已保存到: ' + baseName(currentFilePath));
      toast('已保存');
    }
    if (!options.silent) void refreshFileTree(currentFilePath);
    return true;
  } catch (error) {
    toast('保存失败: ' + error.message);
    return false;
  } finally {
    saveInFlight = false;
  }
}

// ============ 图片插入 ============
async function handleImageInsert(blob, callback) {
  if (!blob) { callback(''); return; }
  if (!currentFilePath) {
    toast('请先保存文件，再插入图片');
    await saveFile(false);
    if (!currentFilePath) { callback(''); return; }
  }
  try {
    // blob 转 ArrayBuffer 发给主进程
    const arrayBuffer = await blob.arrayBuffer();
    const extensionByType = {
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
      'image/webp': 'webp',
      'image/svg+xml': 'svg'
    };
    const extension = extensionByType[blob.type] || 'png';
    const hasSupportedName = typeof blob.name === 'string' &&
      /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(blob.name);
    const fileName = hasSupportedName ? blob.name : `image-${Date.now()}.${extension}`;
    const res = await window.api.saveImageBlob(currentFilePath, fileName, arrayBuffer);
    if (res.error) { toast(res.error); callback(''); return; }
    callback(res.markdownUrl, res.alt);
  } catch (error) {
    toast('保存图片失败: ' + error.message);
    callback('');
  }
}

// ============ 打印与导出 ============
async function printDocument() {
  try {
    setStatus('正在准备打印…');
    const result = await window.api.printDocument(editor.getMarkdown());
    if (result && result.error) { toast('打印失败: ' + result.error); return; }
    if (result && result.canceled) { setStatus('已取消打印'); return; }
    setStatus('已发送到打印机');
  } catch (error) {
    toast('打印失败: ' + error.message);
  }
}

async function exportDocument(format) {
  try {
    const extension = format === 'pdf' ? 'pdf' : 'html';
    let suggestedPath = null;
    if (currentFilePath) {
      suggestedPath = currentFilePath.replace(/\.(md|markdown|mdown|txt)$/i, `.${extension}`);
    }
    setStatus(`正在导出 ${extension.toUpperCase()}…`);
    const result = await window.api.exportDocument(format, editor.getMarkdown(), suggestedPath);
    if (result && result.canceled) { setStatus('已取消导出'); return; }
    if (result && result.error) { toast('导出失败: ' + result.error); return; }
    toast('已导出 ' + baseName(result.filePath));
    setStatus('已导出: ' + result.filePath);
  } catch (error) {
    toast('导出失败: ' + error.message);
  }
}

// ============ 查找与替换 ============
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFindExpression() {
  const query = findInputEl.value;
  if (!query) return null;
  return new RegExp(escapeRegExp(query), caseSensitiveEl.checked ? 'g' : 'gi');
}

function getMarkdownMatches() {
  const expression = getFindExpression();
  if (!expression) return [];
  const content = editor.getMarkdown();
  return Array.from(content.matchAll(expression), (match) => ({
    index: match.index,
    length: match[0].length
  }));
}

function textIndexToLineCol(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, col: index - lineStart + 1 };
}

// 当前模式“可见文本”及其匹配：
// - 源码模式：文本即 Markdown 源，匹配位置可直接用于 setSelection。
// - 所见即所得模式：遍历 ProseMirror 文档构建 文本↔位置 映射，块边界插 \n
//   防止跨块误匹配。查找/计数/高亮始终基于用户看得见的文本，与 Markdown
//   源中的替换通过序号一一对应。
function getVisibleMatches() {
  const expression = getFindExpression();
  if (!expression) return { text: '', map: [], matches: [] };
  if (currentEditMode === 'markdown') {
    const text = editor.getMarkdown();
    return { text, map: null, matches: Array.from(text.matchAll(expression), (m) => ({ index: m.index, length: m[0].length })) };
  }
  let text = '';
  const map = [];
  let view = null;
  try {
    view = editor.getCurrentModeEditor().view;
  } catch (_) {
    return { text: '', map: [], matches: [] };
  }
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      map.push({ start: text.length, end: text.length + node.text.length, pos });
      text += node.text;
      return true;
    }
    if (node.isLeaf) {
      const size = Math.max(node.nodeSize, 1);
      map.push({ start: text.length, end: text.length + size, pos, leaf: true });
      text += '\ufffc';
      return false;
    }
    if (node.isBlock && text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
    }
    return true;
  });
  const matches = Array.from(text.matchAll(expression), (m) => ({ index: m.index, length: m[0].length }));
  return { text, map, matches };
}

function modePositionForIndex(visible, index) {
  if (!visible.map) return index;
  for (const entry of visible.map) {
    if (index >= entry.start && index <= entry.end) {
      return entry.pos + (index - entry.start);
    }
  }
  const last = visible.map[visible.map.length - 1];
  return last ? last.pos + (last.end - last.start) : 0;
}

// 高亮第 n 个匹配：源码模式用 [行, 列]，所见即所得模式用文档偏移量。
// 焦点在查找输入框（编辑器未聚焦）时 ProseMirror 既不滚动也不同步选区高亮，
// 因此：① 手动滚入视区；② 用独立高亮框标记匹配位置（不占用 DOM 选区，
// 不改变焦点，Enter 可连续查找）。
function highlightMatch(visible, match) {
  const startIndex = match.index;
  const endIndex = match.index + Math.max(match.length, 1);
  if (currentEditMode === 'markdown') {
    const from = textIndexToLineCol(visible.text, startIndex);
    const to = textIndexToLineCol(visible.text, endIndex);
    editor.setSelection([from.line, from.col], [to.line, to.col]);
  } else {
    editor.setSelection(modePositionForIndex(visible, startIndex), modePositionForIndex(visible, endIndex));
  }
  scrollEditorSelectionIntoView();
  showMatchHighlight();
}

// 把当前 PM 选区滚动到编辑器可视区约 1/3 高度处（已可见则不动）。
// 不依赖编辑器焦点，覆盖查找面板/大纲面板持有焦点的场景。
function scrollEditorSelectionIntoView() {
  let view = null;
  try {
    view = editor.getCurrentModeEditor().view;
  } catch (_) { return; }
  if (!view || !view.dom) return;
  try {
    const coords = view.coordsAtPos(view.state.selection.head);
    let scroller = view.dom;
    while (scroller && scroller !== document.body) {
      if (scroller.scrollHeight > scroller.clientHeight + 4 &&
          /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) return;
    const rect = scroller.getBoundingClientRect();
    if (coords.top >= rect.top && coords.bottom <= rect.bottom) return; // 已在可视区
    scroller.scrollTop += coords.top - rect.top - rect.height * 0.35;
  } catch (_) { /* 滚动失败不影响查找结果 */ }
}

// ============ 查找匹配高亮框 ============
// 浏览器只绘制焦点元素内的选区；焦点在查找面板时编辑器选区不可见，
// 因此用独立的覆盖层标记当前匹配（不改变焦点，Enter 可连续查找）。
let matchHighlightLayer = null;
let matchHighlightActive = false;

function hideMatchHighlight() {
  matchHighlightActive = false;
  if (matchHighlightLayer) matchHighlightLayer.replaceChildren();
}

// 依据当前 PM 选区绘制高亮框（跨行匹配按行拆成多个矩形）。
function showMatchHighlight() {
  let view = null;
  try {
    view = editor.getCurrentModeEditor().view;
  } catch (_) { return; }
  if (!view || !view.dom) { hideMatchHighlight(); return; }
  try {
    const { from, to } = view.state.selection;
    if (to <= from) { hideMatchHighlight(); return; }
    const startPos = view.domAtPos(from);
    const endPos = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    ).slice(0, 40);
    if (!rects.length) { hideMatchHighlight(); return; }

    if (!matchHighlightLayer) {
      matchHighlightLayer = document.createElement('div');
      matchHighlightLayer.className = 'match-highlight-layer';
      document.body.appendChild(matchHighlightLayer);
    }
    matchHighlightLayer.replaceChildren();
    for (const rect of rects) {
      const box = document.createElement('div');
      box.className = 'match-highlight-box';
      box.style.left = `${rect.left - 2}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width + 4}px`;
      box.style.height = `${rect.height}px`;
      matchHighlightLayer.appendChild(box);
    }
    matchHighlightLayer.style.display = 'block';
    matchHighlightActive = true;
  } catch (_) {
    hideMatchHighlight();
  }
}

// 覆盖层用 fixed 定位，滚动/缩放后需按当前选区重算位置。
function repositionMatchHighlight() {
  if (matchHighlightActive) showMatchHighlight();
}

function updateFindCount() {
  const signature = `${currentEditMode}:${caseSensitiveEl.checked ? '1' : '0'}:${findInputEl.value}`;
  if (signature !== lastFindSignature) {
    lastFindSignature = signature;
    currentFindMatch = -1;
  }
  const count = getVisibleMatches().matches.length;
  if (currentFindMatch >= count) currentFindMatch = count - 1;
  findCountEl.textContent = currentFindMatch >= 0 ? `${currentFindMatch + 1}/${count}` : `${count} 处`;
  findCountEl.classList.toggle('no-result', Boolean(findInputEl.value) && count === 0);
  return count;
}

function showFindPanel(replaceMode = false) {
  findPanelEl.hidden = false;
  if (replaceMode) findPanelEl.classList.add('replace-mode');
  updateFindCount();
  // 焦点即将移到查找输入框，光标位置显示随之清空（不依赖编辑器 blur 事件）。
  updateCursorPos(null);
  requestAnimationFrame(() => {
    findInputEl.focus();
    findInputEl.select();
  });
}

function closeFindPanel() {
  findPanelEl.hidden = true;
  hideMatchHighlight();
  editor.focus();
}

function findInEditor(backwards = false) {
  const query = findInputEl.value;
  if (!query) {
    showFindPanel();
    return false;
  }
  const visible = getVisibleMatches();
  const count = visible.matches.length;
  if (count === 0) {
    findCountEl.textContent = '0 处';
    findCountEl.classList.add('no-result');
    toast('未找到匹配内容');
    return false;
  }
  currentFindMatch = backwards
    ? (currentFindMatch <= 0 ? count - 1 : currentFindMatch - 1)
    : (currentFindMatch + 1) % count;
  findCountEl.textContent = `${currentFindMatch + 1}/${count}`;
  findCountEl.classList.remove('no-result');
  highlightMatch(visible, visible.matches[currentFindMatch]);
  return true;
}

// 编辑器滚动容器：所见即所得为可见的 ProseMirror 内容区，源码模式还有预览列。
function getVisibleScrollContainers() {
  return Array.from(document.querySelectorAll(
    '.toastui-editor .ProseMirror, .toastui-editor-md-preview'
  )).filter((el) => el.offsetParent !== null);
}

function captureEditorScroll() {
  return getVisibleScrollContainers().map((el) => ({
    preview: el.classList.contains('toastui-editor-md-preview'),
    top: el.scrollTop
  }));
}

function restoreEditorScroll(captured) {
  if (!captured || !captured.length) return;
  requestAnimationFrame(() => {
    for (const snapshot of captured) {
      const el = getVisibleScrollContainers()
        .find((candidate) => candidate.classList.contains('toastui-editor-md-preview') === snapshot.preview);
      if (el) el.scrollTop = snapshot.top;
    }
  });
}

function replaceCurrentMatch() {
  if (!findInputEl.value) return;
  const visible = getVisibleMatches();
  if (visible.matches.length === 0) { toast('未找到匹配内容'); return; }
  if (currentFindMatch < 0 || currentFindMatch >= visible.matches.length) currentFindMatch = 0;

  // 替换操作针对 Markdown 源文件内容；通过“第 n 个匹配”的序号对齐当前高亮项。
  const markdownMatches = getMarkdownMatches();
  let mdMatch = null;
  if (currentEditMode === 'markdown') {
    mdMatch = visible.matches[currentFindMatch];
  } else if (markdownMatches.length === visible.matches.length) {
    mdMatch = markdownMatches[currentFindMatch];
  }
  if (!mdMatch) {
    toast('当前视图下无法对齐替换位置，请切换到源码模式');
    return;
  }

  const content = editor.getMarkdown();
  const nextContent = content.slice(0, mdMatch.index) +
    replaceInputEl.value +
    content.slice(mdMatch.index + mdMatch.length);
  const scroll = captureEditorScroll();
  editor.setMarkdown(nextContent, false);
  restoreEditorScroll(scroll);
  currentFindMatch -= 1;
  updateFindCount();
  findInEditor(false);
}

function replaceAllMatches() {
  const expression = getFindExpression();
  if (!expression) return;
  const content = editor.getMarkdown();
  const matches = content.match(expression) || [];
  if (matches.length === 0) {
    toast('未找到匹配内容');
    return;
  }
  const scroll = captureEditorScroll();
  const nextContent = content.replace(expression, () => replaceInputEl.value);
  editor.setMarkdown(nextContent, false);
  restoreEditorScroll(scroll);
  currentFindMatch = -1;
  updateFindCount();
  toast(`已替换 ${matches.length} 处`);
}

// ============ 拖拽 ============
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (hasFiles(e)) { dragCounter++; dropOverlay.classList.add('active'); }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (hasFiles(e)) { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active'); } }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  const file = Array.from(e.dataTransfer.files)[0];
  if (!file) return;
  const filePath = window.api.getPathForFile(file);
  if (!filePath) return;
  if (!/\.(md|markdown|mdown|txt)$/i.test(filePath)) {
    toast('仅支持 Markdown 文件 (.md/.markdown/.mdown/.txt)');
    return;
  }
  try {
    const res = await window.api.openPath(filePath);
    if (res.error) { toast('打开失败: ' + res.error); return; }
    if (!(await confirmBeforeReplace())) return;
    loadContent(res.filePath, res.content, res.baseUrl);
  } catch (error) {
    toast('打开失败: ' + error.message);
  }
});

function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

// ============ 工具栏按钮 ============
document.getElementById('btn-new').addEventListener('click', () => newDocument());
document.getElementById('btn-open').addEventListener('click', openFile);
document.getElementById('btn-save').addEventListener('click', () => saveFile(false));
sidebarButtonEl.addEventListener('click', () => setSidebarCollapsed(!sidebarCollapsed));
sidebarRefreshButtonEl.addEventListener('click', () => void refreshFileTree());
tabFilesEl.addEventListener('click', () => setSidebarTab('files'));
tabOutlineEl.addEventListener('click', () => setSidebarTab('outline'));
document.getElementById('btn-find').addEventListener('click', () => showFindPanel(false));
modeButtonEl.addEventListener('click', toggleEditMode);
document.getElementById('btn-theme').addEventListener('click', toggleTheme);

document.getElementById('btn-find-expand').addEventListener('click', () => {
  findPanelEl.classList.toggle('replace-mode');
  if (findPanelEl.classList.contains('replace-mode')) {
    replaceInputEl.focus();
    updateCursorPos(null);
  }
});
document.getElementById('btn-find-prev').addEventListener('click', () => findInEditor(true));
document.getElementById('btn-find-next').addEventListener('click', () => findInEditor(false));
document.getElementById('btn-find-close').addEventListener('click', closeFindPanel);
document.getElementById('btn-replace').addEventListener('click', replaceCurrentMatch);
document.getElementById('btn-replace-all').addEventListener('click', replaceAllMatches);
findInputEl.addEventListener('input', () => {
  hideMatchHighlight();
  updateFindCount();
});
caseSensitiveEl.addEventListener('change', updateFindCount);
findInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    findInEditor(event.shiftKey);
  } else if (event.key === 'Escape') {
    closeFindPanel();
  }
});
replaceInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.ctrlKey ? replaceAllMatches() : replaceCurrentMatch();
  } else if (event.key === 'Escape') {
    closeFindPanel();
  }
});

function handleEditorCommand(name, payload = {}) {
  try {
    switch (name) {
      case 'new': void newDocument(); break;
      case 'find': showFindPanel(false); break;
      case 'replace': showFindPanel(true); break;
      case 'findNext':
        if (findPanelEl.hidden) showFindPanel(false);
        else findInEditor(false);
        break;
      case 'findPrevious':
        if (findPanelEl.hidden) showFindPanel(false);
        else findInEditor(true);
        break;
      case 'toggleMode': toggleEditMode(); break;
      case 'toggleSidebar': setSidebarCollapsed(!sidebarCollapsed); break;
      case 'showOutline': setSidebarTab('outline'); break;
      case 'followSystemTheme': void followSystemTheme(); break;
      case 'print': void printDocument(); break;
      case 'export': void exportDocument(payload.format === 'html' ? 'html' : 'pdf'); break;
      case 'autoSaveChanged': setAutoSaveEnabled(Boolean(payload.enabled)); break;
      case 'setFontSize':
        editorFontPrefs.size = Math.min(28, Math.max(12, Number(payload.size) || 16));
        window.api.setPreference({ editorFontSize: editorFontPrefs.size });
        applyEditorFontPrefs();
        setStatus(`正文字号：${editorFontPrefs.size}px`);
        break;
      case 'setFontFamily':
        if (Object.prototype.hasOwnProperty.call(FONT_FAMILY_VALUES, payload.family)) {
          editorFontPrefs.family = payload.family;
          window.api.setPreference({ editorFontFamily: editorFontPrefs.family });
          applyEditorFontPrefs();
          setStatus('正文字体已更新');
        }
        break;
      case 'popup': openToolbarPopup(payload.name); break;
      case 'dateTime': editor.insertText('\n' + nowString() + '\n'); break;
      default: editor.exec(name, payload); break;
    }
  } catch (error) {
    console.warn('编辑命令失败:', name, error);
    toast('该编辑操作当前不可用');
  }
}

// ============ 菜单事件 ============
window.api.onMenuOpen(() => openFile());
window.api.onMenuSave(() => saveFile(false));
window.api.onMenuSaveAs(() => saveFile(true));
window.api.onMenuToggleTheme(() => toggleTheme());
window.api.onEditorCommand(handleEditorCommand);
window.api.onSystemThemeChanged((theme) => applyTheme(theme, true));
window.api.onSaveBeforeClose(async () => {
  if (await saveFile(false)) window.api.closeAfterSave();
});
window.api.onZoomLevelChanged((level) => updateZoomLevel(level));
window.api.onFileExternalChanged(() => {
  toast('文件已在磁盘上被外部修改');
  setStatus('文件已被外部程序修改；如需最新内容请从侧边栏重新打开');
});

// ============ 右键上下文菜单（类 Typora）============
const MENU_ITEMS = [
  { label: '撤销', hotkey: 'Ctrl+Z', action: () => editor.exec('undo') },
  { label: '重做', hotkey: 'Ctrl+Shift+Z', action: () => editor.exec('redo') },
  { divider: true },
  { label: '剪切', hotkey: 'Ctrl+X', action: () => document.execCommand('cut') },
  { label: '复制', hotkey: 'Ctrl+C', action: () => document.execCommand('copy') },
  { label: '粘贴', hotkey: 'Ctrl+V', action: () => document.execCommand('paste') },
  { label: '全选', hotkey: 'Ctrl+A', action: () => editor.exec('selectAll') },
  { divider: true },
  {
    label: '段落', submenu: [
      { label: '正文', hotkey: 'Ctrl+0', action: () => editor.exec('heading', { level: 0 }) },
      ...Array.from({ length: 6 }, (_, index) => ({
        label: `${index + 1} 级标题`,
        hotkey: `Ctrl+${index + 1}`,
        action: () => editor.exec('heading', { level: index + 1 })
      })),
      { divider: true },
      { label: '引用块', action: () => editor.exec('blockQuote') },
      { label: '无序列表', action: () => editor.exec('bulletList') },
      { label: '有序列表', action: () => editor.exec('orderedList') },
      { label: '任务列表', action: () => editor.exec('taskList') },
      { label: '代码块', action: () => editor.exec('codeBlock') },
    ]
  },
  {
    label: '格式', submenu: [
      { label: '加粗', hotkey: 'Ctrl+B', action: () => editor.exec('bold') },
      { label: '斜体', hotkey: 'Ctrl+I', action: () => editor.exec('italic') },
      { label: '删除线', action: () => editor.exec('strike') },
      { label: '行内代码', action: () => editor.exec('code') },
      { divider: true },
      { label: '插入链接…', hotkey: 'Ctrl+K', action: () => openToolbarPopup('link') },
      { divider: true },
      { label: '增加缩进', action: () => editor.exec('indent') },
      { label: '减少缩进', action: () => editor.exec('outdent') },
    ]
  },
  {
    label: '插入', submenu: [
      { label: '图片…', action: () => openToolbarPopup('image') },
      { label: '链接…', hotkey: 'Ctrl+K', action: () => openToolbarPopup('link') },
      { label: '表格', action: () => openToolbarPopup('table') },
      { label: '代码块', action: () => editor.exec('codeBlock') },
      { label: '水平分割线', action: () => editor.exec('hr') },
      { label: '日期时间', action: () => editor.insertText('\n' + nowString() + '\n') },
    ]
  },
  { divider: true },
  { label: '查找…', hotkey: 'Ctrl+F', action: () => showFindPanel(false) },
  { label: '替换…', hotkey: 'Ctrl+H', action: () => showFindPanel(true) },
  { label: '切换源码模式', hotkey: 'Ctrl+/', action: () => toggleEditMode() },
  { label: '切换主题', hotkey: 'Ctrl+Shift+T', action: () => toggleTheme() },
];

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Toast UI 的图片、链接和表格不是无参命令，而是工具栏弹窗。
// 延迟到当前 mousedown 完成后再点击，否则其全局监听器会立刻关闭刚打开的弹窗。
function openToolbarPopup(name) {
  setTimeout(() => {
    const button = document.querySelector(`.toastui-editor-toolbar-icons.${name}`);
    if (button && !button.disabled) {
      button.click();
    } else {
      toast('当前无法执行该插入操作');
    }
  }, 0);
}

// ---- 菜单渲染 ----
let contextMenuEl = null;

function hideContextMenu() {
  document.querySelectorAll('.ctx-submenu').forEach(el => el.remove());
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}

function buildMenu(items, isSubmenu = false) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu' + (isSubmenu ? ' ctx-submenu' : '');
  items.forEach((item) => {
    if (item.divider) {
      const sep = document.createElement('div');
      sep.className = 'ctx-divider';
      menu.appendChild(sep);
      return;
    }
    const row = document.createElement('div');
    row.className = 'ctx-item';
    row.dataset.menuLabel = item.label;
    row.addEventListener('mouseenter', () => {
      if (item.submenu) {
        showSubmenu(row, item.submenu);
      } else if (!isSubmenu) {
        document.querySelectorAll('.ctx-submenu').forEach(el => el.remove());
      }
    });
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (item.submenu) { showSubmenu(row, item.submenu); return; }
      try { item.action && item.action(); } catch (err) { console.warn('菜单项失败:', item.label, err); }
      finally { hideContextMenu(); }
    });
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = item.label;
    row.appendChild(label);
    if (item.hotkey) {
      const hk = document.createElement('span');
      hk.className = 'ctx-hotkey';
      hk.textContent = item.hotkey;
      row.appendChild(hk);
    }
    if (item.submenu) {
      const arrow = document.createElement('span');
      arrow.className = 'ctx-arrow';
      arrow.textContent = '▸';
      row.appendChild(arrow);
    }
    menu.appendChild(row);
  });
  return menu;
}

function showSubmenu(parentRow, items) {
  document.querySelectorAll('.ctx-submenu').forEach(el => el.remove());
  const sub = buildMenu(items, true);
  document.body.appendChild(sub);
  const rect = parentRow.getBoundingClientRect();
  let left = rect.right - 2;
  let top = rect.top - 4;
  if (left + sub.offsetWidth > window.innerWidth) left = rect.left - sub.offsetWidth + 2;
  if (top + sub.offsetHeight > window.innerHeight) top = window.innerHeight - sub.offsetHeight - 8;
  sub.style.left = Math.max(8, left) + 'px';
  sub.style.top = Math.max(8, top) + 'px';
}

function showContextMenu(x, y) {
  hideContextMenu();
  contextMenuEl = buildMenu(MENU_ITEMS, false);
  document.body.appendChild(contextMenuEl);
  contextMenuEl.style.visibility = 'hidden';
  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
  const w = contextMenuEl.offsetWidth, h = contextMenuEl.offsetHeight;
  const left = x + w > window.innerWidth ? window.innerWidth - w - 8 : x;
  const top = y + h > window.innerHeight ? window.innerHeight - h - 8 : y;
  contextMenuEl.style.left = Math.max(8, left) + 'px';
  contextMenuEl.style.top = Math.max(8, top) + 'px';
  contextMenuEl.style.visibility = 'visible';
}

function setupContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    // 在编辑区内弹自定义菜单
    const inEditor = e.target.closest('.toastui-editor');
    if (!inEditor) return;
    if (e.target.closest('.toastui-editor-defaultUI-toolbar')) return;  // 工具栏用默认
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', (e) => {
    if (!contextMenuEl) return;
    if (e.target.closest('.ctx-menu') || e.target.closest('.ctx-submenu')) return;
    hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      // Escape 任何位置都能关闭查找面板（不只是面板内的输入框）。
      if (!findPanelEl.hidden) closeFindPanel();
    }
  });
  window.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);
}

// ============ 启动 ============
async function init() {
  // 偏好：持久化主题优先；'system' 跟随系统。
  let storedPrefs = null;
  try {
    storedPrefs = await window.api.getPreferences();
    if (storedPrefs && (storedPrefs.theme === 'light' || storedPrefs.theme === 'dark')) {
      currentTheme = storedPrefs.theme;
      followsSystemTheme = false;
    } else {
      currentTheme = await window.api.getSystemTheme();
      followsSystemTheme = true;
    }
  } catch (e) { /* 默认 light */ }
  setAutoSaveEnabled(Boolean(storedPrefs && storedPrefs.autoSave));
  editorFontPrefs = {
    size: (storedPrefs && Number(storedPrefs.editorFontSize)) || 16,
    family: (storedPrefs && storedPrefs.editorFontFamily) || '',
  };
  applyEditorFontPrefs();
  document.body.classList.toggle('theme-dark', currentTheme === 'dark');
  document.body.classList.toggle('theme-light', currentTheme === 'light');
  themeIconEl.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  setSidebarCollapsed(sidebarCollapsed, false);

  editor = createEditor('');
  window.editor = editor;
  mermaidDOMObserver.observe(document.getElementById('editor'), {
    childList: true,
    subtree: true,
    characterData: true
  });
  // Mermaid 预览位于 ProseMirror 之外，滚动本身不会产生 DOM 变更；在捕获阶段
  // 监听内部滚动，及时重新对齐预览层，避免图表与它覆盖的源码块分离。
  document.getElementById('editor').addEventListener('scroll', scheduleMermaidRender, true);
  // 查找高亮框为 fixed 定位，滚动/缩放后重算位置。
  document.getElementById('editor').addEventListener('scroll', repositionMatchHighlight, true);
  window.addEventListener('resize', repositionMatchHighlight);
  window.addEventListener('resize', scheduleMermaidRender);
  updateEditMode(currentEditMode);
  updateWordCount(editor.getMarkdown());
  updateTitle();
  setStatus('已新建空白文档');
  setupContextMenu();
  watchEditorFocusLoss();
  setupCodeCopyButtons();

  try {
    const startupDocument = await window.api.takeStartupDocument();
    if (startupDocument && !startupDocument.canceled) {
      if (startupDocument.error) toast('打开启动文档失败: ' + startupDocument.error);
      else loadContent(startupDocument.filePath, startupDocument.content, startupDocument.baseUrl);
    }
  } catch (error) {
    toast('读取启动文档失败: ' + error.message);
  }

  window.api.notifyRendererReady();
  if (pendingSystemDocumentPath) {
    const filePath = pendingSystemDocumentPath;
    pendingSystemDocumentPath = null;
    await openSystemDocument(filePath);
  }

  // 崩溃恢复：存在备份时询问用户是否恢复（读取即清除，放弃则不保留）。
  try {
    const backup = await window.api.takeBackup();
    if (backup && typeof backup.content === 'string' && backup.content !== '') {
      const choice = await window.api.confirmBackupRestore(backup);
      if (choice === 'restore') {
        loadContent(backup.filePath, backup.content, backup.baseUrl);
        lastSavedContent = '';
        setDirty(true);
        toast('已恢复上次未保存的内容');
        setStatus('已恢复上次未保存的内容（Ctrl+S 保存）');
      }
    }
  } catch (_) { /* 恢复流程失败不影响正常使用 */ }
}

// ============ 字号/字体 ============
const FONT_FAMILY_VALUES = {
  '': '',
  'sans': '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  'serif': 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  'mono': 'Consolas, "Courier New", monospace',
};

function applyEditorFontPrefs() {
  const root = document.documentElement;
  const size = Math.min(28, Math.max(12, Number(editorFontPrefs.size) || 16));
  root.style.setProperty('--md-reader-font-size', `${size}px`);
  const family = FONT_FAMILY_VALUES[editorFontPrefs.family];
  if (family) root.style.setProperty('--md-reader-font-family', family);
  else root.style.removeProperty('--md-reader-font-family');
}

// ============ 代码块复制按钮 ============
// 所见即所得的代码块位于 ProseMirror 受管 DOM 内，直接插入子节点会被 PM 同步移除；
// 因此用单个悬浮按钮覆盖在悬停的代码块右上角，源码预览与所见即所得两种模式通用。
const codeCopyButton = document.createElement('button');
codeCopyButton.type = 'button';
codeCopyButton.className = 'code-block-copy-btn';
codeCopyButton.textContent = '复制';
let codeCopyTargetPre = null;

function isCopyableCodePre(pre) {
  return Boolean(pre && pre.textContent && pre.textContent.trim() &&
    !pre.closest('.mermaid-diagram') && !pre.closest('.mermaid-wysiwyg-code-block'));
}

function hideCodeCopyButton() {
  codeCopyTargetPre = null;
  codeCopyButton.classList.remove('visible');
}

function positionCodeCopyButton(pre) {
  codeCopyTargetPre = pre;
  const rect = pre.getBoundingClientRect();
  const buttonWidth = 56;
  codeCopyButton.style.top = `${Math.round(Math.max(0, rect.top + 6))}px`;
  codeCopyButton.style.left = `${Math.round(Math.max(8, rect.right - buttonWidth - 10))}px`;
  codeCopyButton.classList.add('visible');
}

function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => copyViaExecCommand(text));
  }
  return Promise.resolve(copyViaExecCommand(text));
}

function copyViaExecCommand(text) {
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

function setupCodeCopyButtons() {
  codeCopyButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const pre = codeCopyTargetPre;
    if (!pre) return;
    const code = pre.querySelector('code') || pre;
    const text = (code.textContent || '').replace(/\n$/, '');
    copyTextToClipboard(text).then((ok) => {
      codeCopyButton.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { codeCopyButton.textContent = '复制'; }, 1200);
    });
  });
  document.addEventListener('mouseover', (event) => {
    const pre = event.target && event.target.closest
      ? event.target.closest('.toastui-editor-md-preview pre, .toastui-editor-ww-container pre')
      : null;
    if (!isCopyableCodePre(pre)) {
      if (codeCopyTargetPre) hideCodeCopyButton();
      return;
    }
    if (pre !== codeCopyTargetPre || !codeCopyButton.classList.contains('visible')) {
      positionCodeCopyButton(pre);
    }
  });
  // 悬浮按钮为 fixed 定位，滚动/缩放后位置失准，先隐藏待下次悬停重新定位。
  window.addEventListener('scroll', hideCodeCopyButton, true);
  window.addEventListener('resize', hideCodeCopyButton);
  document.body.appendChild(codeCopyButton);
}

init();
