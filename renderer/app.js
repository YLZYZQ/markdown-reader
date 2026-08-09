// 渲染进程：基于 Toast UI Editor 的 Markdown 编辑器
'use strict';

// ============ DOM ============
const filenameEl = document.getElementById('filename');
const statusInfoEl = document.getElementById('status-info');
const wordCountEl = document.getElementById('word-count');
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

// 后续会把 <base> 指向当前文档目录；先固定应用自身样式资源的绝对地址。
document.querySelectorAll('link[href]').forEach((link) => link.setAttribute('href', link.href));

// ============ 状态 ============
let editor = null;
window.editor = null;
let currentFilePath = null;
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
const mermaidWysiwygPreviews = new Map();

function isMermaidCodeBlock(node) {
  const language = (node.info || '').trim().split(/\s+/, 1)[0].toLowerCase();
  return isMermaidSource(language, node.literal || '');
}

function isMermaidSource(language, source) {
  if (language === 'mermaid') return true;

  // Toast UI 新建代码块时默认使用 markup。对明显的 Mermaid 流程图兼容识别，
  // 这样旧文档无需逐个修改围栏语言；其他 markup 代码仍按普通代码显示。
  return language === 'markup' && /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/i.test(source);
}

const mermaidHTMLRenderer = {
  codeBlock(node, context) {
    if (!isMermaidCodeBlock(node)) return context.origin();
    context.skipChildren();
    return [
      {
        type: 'openTag',
        tagName: 'div',
        classNames: ['mermaid-diagram'],
        attributes: { contenteditable: 'false' },
        outerNewLine: true
      },
      { type: 'text', content: node.literal || '' },
      { type: 'closeTag', tagName: 'div', outerNewLine: true }
    ];
  }
};

function configureMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: currentTheme === 'dark' ? 'dark' : 'default'
  });
}

async function renderMermaidDiagrams() {
  prepareWysiwygMermaidDiagrams();
  if (mermaidRenderRunning) {
    mermaidRenderRequested = true;
    return;
  }

  const diagrams = Array.from(document.querySelectorAll(
    '.toastui-editor-md-preview .mermaid-diagram:not([data-mermaid-rendered]), ' +
    '.mermaid-wysiwyg-preview:not([data-mermaid-rendered])'
  ));
  if (!diagrams.length) return;

  mermaidRenderRunning = true;
  configureMermaid();
  for (const diagram of diagrams) {
    if (!diagram.isConnected || diagram.dataset.mermaidRendering === 'true') continue;
    const isWysiwygDiagram = diagram.classList.contains('mermaid-wysiwyg-preview');
    const source = isWysiwygDiagram ? diagram.mermaidSource || '' : diagram.textContent || '';
    diagram.dataset.mermaidRendering = 'true';
    try {
      const id = `mermaid-diagram-${++mermaidDiagramId}`;
      const { svg, bindFunctions } = await mermaid.render(id, source);
      if (!diagram.isConnected) continue;
      if (isWysiwygDiagram) {
        // 直接插入 SVG，而不是将其编码为 CSS 背景。复杂图的 SVG 含有大量
        // CSS 选择器；作为 data URL 时 Chromium 在从源码模式切换后可能不绘制它。
        diagram.innerHTML = svg;
        diagram.setAttribute('role', 'img');
        diagram.setAttribute('aria-label', 'Mermaid 图表');
      } else {
        diagram.innerHTML = svg;
      }
      diagram.dataset.mermaidRendered = 'true';
      diagram.removeAttribute('data-mermaid-rendering');
      diagram.removeAttribute('data-mermaid-error');
      if (bindFunctions) bindFunctions(diagram);
    } catch (error) {
      if (!diagram.isConnected) continue;
      if (!isWysiwygDiagram) diagram.textContent = source;
      else {
        diagram.style.backgroundImage = '';
        diagram.textContent = `Mermaid 图表语法错误\n${source}`;
      }
      diagram.dataset.mermaidRendered = 'true';
      diagram.dataset.mermaidError = 'true';
      diagram.removeAttribute('data-mermaid-rendering');
      console.warn('Mermaid 图表渲染失败:', error);
    }
  }
  mermaidRenderRunning = false;

  if (mermaidRenderRequested) {
    mermaidRenderRequested = false;
    scheduleMermaidRender();
  }
}

function prepareWysiwygMermaidDiagrams() {
  for (const [wrapper, preview] of mermaidWysiwygPreviews) {
    if (!wrapper.isConnected || !preview.isConnected) {
      preview.remove();
      mermaidWysiwygPreviews.delete(wrapper);
    }
  }

  document.querySelectorAll('.toastui-editor-ww-code-block-highlighting').forEach((wrapper) => {
    const code = wrapper.querySelector('pre code');
    const source = code ? code.textContent || '' : '';
    const language = (wrapper.dataset.language || '').trim().split(/\s+/, 1)[0].toLowerCase();
    let preview = mermaidWysiwygPreviews.get(wrapper);

    if (!isMermaidSource(language, source)) {
      if (preview) preview.remove();
      mermaidWysiwygPreviews.delete(wrapper);
      return;
    }

    const container = wrapper.closest('.toastui-editor-ww-container');
    if (!container) return;
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'mermaid-wysiwyg-preview';
      preview.setAttribute('contenteditable', 'false');
      preview.setAttribute('role', 'img');
      preview.setAttribute('aria-label', 'Mermaid 图表');
      container.appendChild(preview);
      mermaidWysiwygPreviews.set(wrapper, preview);
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    preview.style.left = `${wrapperRect.left - containerRect.left + container.scrollLeft}px`;
    preview.style.top = `${wrapperRect.top - containerRect.top + container.scrollTop}px`;
    preview.style.width = `${wrapperRect.width}px`;
    preview.style.height = `${wrapperRect.height}px`;

    if (preview.mermaidSource !== source) {
      preview.mermaidSource = source;
      preview.innerHTML = '';
      preview.style.backgroundImage = '';
      preview.removeAttribute('data-mermaid-rendered');
      preview.removeAttribute('data-mermaid-error');
    }
  });
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
  currentTheme = theme;
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-light', theme === 'light');
  themeIconEl.textContent = theme === 'dark' ? '☀️' : '🌙';
  themeIconEl.parentElement.title =
    `切换主题 (当前: ${theme === 'dark' ? '暗色' : '亮色'}${fromSystem ? '，跟随系统' : ''})`;
  // Toast UI 主题：重建编辑器（官方推荐方式）
  rebuildEditor();
}

function toggleTheme() {
  followsSystemTheme = false;
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
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
    plugins: [codeSyntaxHighlight],  // 代码语法高亮（含全部 prism 语言）
    customHTMLRenderer: mermaidHTMLRenderer,
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
      },
      changeMode: (mode) => {
        updateEditMode(mode);
        scheduleMermaidRender();
      }
    }
  });
  instance.on('afterPreviewRender', scheduleMermaidRender);
  scheduleMermaidRender();
  return instance;
}

// 重建编辑器（用于切换主题）
function rebuildEditor() {
  if (!editor) return;
  const md = editor.getMarkdown();
  const scrollContainer = document.querySelector('.toastui-editor-ww-container, .toastui-editor-md-preview');
  const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
  const wasDirty = isDirty;
  editor.destroy();
  editor = createEditor(md);
  window.editor = editor;
  setDirty(wasDirty);
  requestAnimationFrame(() => {
    const nextScrollContainer = document.querySelector('.toastui-editor-ww-container, .toastui-editor-md-preview');
    if (nextScrollContainer) nextScrollContainer.scrollTop = scrollTop;
  });
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

function setStatus(text) {
  statusInfoEl.textContent = text;
}

function updateWordCount(md) {
  const text = (md || '').replace(/[#*`>\-_\[\]()!|=\s]/g, '');
  wordCountEl.textContent = `${text.length} 字`;
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
  currentFilePath = filePath;
  setDocumentBase(baseUrl);
  editor.setMarkdown(content, false);
  // Toast UI 可能规范化末尾换行；以编辑器实际内容作为已保存基线，避免刚打开就误报修改。
  lastSavedContent = editor.getMarkdown();
  findPanelEl.hidden = true;
  setDirty(false);
  setStatus('已打开: ' + baseName(filePath));
  toast('已打开 ' + baseName(filePath));
  void refreshFileTree(filePath);
}

async function saveFile(saveAs = false) {
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
    setStatus('已保存到: ' + baseName(currentFilePath));
    toast('已保存');
    void refreshFileTree(currentFilePath);
    return true;
  } catch (error) {
    toast('保存失败: ' + error.message);
    return false;
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

// ============ 查找与替换 ============
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFindExpression() {
  const query = findInputEl.value;
  if (!query) return null;
  return new RegExp(escapeRegExp(query), caseSensitiveEl.checked ? 'g' : 'gi');
}

function getFindMatches(content = editor.getMarkdown()) {
  const expression = getFindExpression();
  if (!expression) return [];
  return Array.from(content.matchAll(expression), (match) => ({
    index: match.index,
    length: match[0].length
  }));
}

function updateFindCount() {
  const signature = `${caseSensitiveEl.checked ? '1' : '0'}:${findInputEl.value}`;
  if (signature !== lastFindSignature) {
    lastFindSignature = signature;
    currentFindMatch = -1;
  }
  const count = getFindMatches().length;
  if (currentFindMatch >= count) currentFindMatch = count - 1;
  findCountEl.textContent = currentFindMatch >= 0 ? `${currentFindMatch + 1}/${count}` : `${count} 处`;
  findCountEl.classList.toggle('no-result', Boolean(findInputEl.value) && count === 0);
  return count;
}

function showFindPanel(replaceMode = false) {
  findPanelEl.hidden = false;
  if (replaceMode) findPanelEl.classList.add('replace-mode');
  updateFindCount();
  requestAnimationFrame(() => {
    findInputEl.focus();
    findInputEl.select();
  });
}

function closeFindPanel() {
  findPanelEl.hidden = true;
  editor.focus();
}

function findInEditor(backwards = false) {
  const query = findInputEl.value;
  if (!query) {
    showFindPanel();
    return false;
  }
  const count = updateFindCount();
  if (count === 0) {
    toast('未找到匹配内容');
    return false;
  }
  currentFindMatch = backwards
    ? (currentFindMatch <= 0 ? count - 1 : currentFindMatch - 1)
    : (currentFindMatch + 1) % count;
  findCountEl.textContent = `${currentFindMatch + 1}/${count}`;
  const found = window.find(
    query,
    caseSensitiveEl.checked,
    backwards,
    true,
    false,
    false,
    false
  );
  if (!found) toast('未找到匹配内容');
  return found;
}

function replaceCurrentMatch() {
  if (!findInputEl.value) return;
  let matches = getFindMatches();
  if (matches.length === 0) { toast('未找到匹配内容'); return; }
  if (currentFindMatch < 0 || currentFindMatch >= matches.length) currentFindMatch = 0;
  const match = matches[currentFindMatch];
  const content = editor.getMarkdown();
  const nextContent = content.slice(0, match.index) +
    replaceInputEl.value +
    content.slice(match.index + match.length);
  editor.setMarkdown(nextContent, false);
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
  const nextContent = content.replace(expression, () => replaceInputEl.value);
  editor.setMarkdown(nextContent, false);
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
    toast('仅支持 Markdown 文件 (.md/.markdown/.txt)');
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
document.getElementById('btn-find').addEventListener('click', () => showFindPanel(false));
modeButtonEl.addEventListener('click', toggleEditMode);
document.getElementById('btn-theme').addEventListener('click', toggleTheme);

document.getElementById('btn-find-expand').addEventListener('click', () => {
  findPanelEl.classList.toggle('replace-mode');
  if (findPanelEl.classList.contains('replace-mode')) replaceInputEl.focus();
});
document.getElementById('btn-find-prev').addEventListener('click', () => findInEditor(true));
document.getElementById('btn-find-next').addEventListener('click', () => findInEditor(false));
document.getElementById('btn-find-close').addEventListener('click', closeFindPanel);
document.getElementById('btn-replace').addEventListener('click', replaceCurrentMatch);
document.getElementById('btn-replace-all').addEventListener('click', replaceAllMatches);
findInputEl.addEventListener('input', updateFindCount);
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
    if (e.key === 'Escape') hideContextMenu();
  });
  window.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);
}

// ============ 启动 ============
async function init() {
  try {
    const sys = await window.api.getSystemTheme();
    currentTheme = sys;
  } catch (e) { /* 默认 light */ }
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
  window.addEventListener('resize', scheduleMermaidRender);
  updateEditMode(currentEditMode);
  updateWordCount(editor.getMarkdown());
  updateTitle();
  setStatus('已新建空白文档');
  setupContextMenu();

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
}

init();
