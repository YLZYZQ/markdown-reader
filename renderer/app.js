// 渲染进程：基于 Toast UI Editor 的 Markdown 编辑器
'use strict';

const i18n = window.AppI18n;

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
const sidebarUpButtonEl = document.getElementById('btn-tree-up');
const tabFilesEl = document.getElementById('tab-files');
const tabOutlineEl = document.getElementById('tab-outline');
const outlinePanelEl = document.getElementById('outline-panel');
const outlineListEl = document.getElementById('outline-list');

// 后续会把 <base> 指向当前文档目录；先固定应用自身样式资源的绝对地址。
document.querySelectorAll('link[href]').forEach((link) => link.setAttribute('href', link.href));

// ============ 状态 ============
let editor = null;
let readingTools = null;
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
let fileTreeRootPath = null;
let fileTreeHomePath = null;
let sidebarCollapsed = false;
let pendingSystemDocumentPath = null;
let autoSaveEnabled = false;
let autoSaveTimer = null;
let backupTimer = null;
let saveInFlight = false;
let editorFontPrefs = { size: 16, family: '' };
let currentLanguage = 'zh-CN';
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
    preview.setAttribute('aria-label', tr('messages.mermaidDiagram'));

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
      this.preview.textContent = `${tr('messages.mermaidError')}\n${source}`;
      this.preview.dataset.mermaidSource = source;
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
  currentTheme = theme;
  document.body.classList.remove('theme-light', 'theme-cream', 'theme-dark');
  document.body.classList.add(`theme-${theme}`);
  themeIconEl.textContent = theme === 'dark' ? '☼' : theme === 'cream' ? '◍' : '◐';
  const themeName = theme === 'dark' ? tr('themes.dark') : theme === 'cream' ? tr('themes.cream') : tr('themes.light');
  themeIconEl.parentElement.title =
    tr('themes.current', { name: themeName }) + (fromSystem ? tr('themes.followSystem') : '');
  // 主题样式由根 class 控制：toastui-editor-dark.css 常驻加载，
  // 切换 defaultUI 上的 dark class 即可换肤；保留编辑器实例、选区与撤销历史。
  document.querySelector('#editor .toastui-editor-defaultUI')
    ?.classList.toggle('toastui-editor-dark', theme === 'dark');
}

function toggleTheme() {
  followsSystemTheme = false;
  const next = currentTheme === 'light' ? 'cream' : currentTheme === 'cream' ? 'dark' : 'light';
  window.api.setPreference({ theme: next });
  applyTheme(next);
}

function setApplicationLanguage(language) {
  if (!i18n.LANGUAGES.includes(language) || language === currentLanguage) return;
  currentLanguage = language;
  applyLanguageChrome();
  if (editor) {
    // Toast UI 3.x caches toolbar labels. Refresh only its UI, keeping both
    // ProseMirror instances, selections and undo histories intact.
    editor.i18n.setCode(language);
    editor.options.language = language;
    editor.eventEmitter.emit('closePopup');
    editor.options.toolbarItems.forEach((group, groupIndex) => {
      group.forEach((item, itemIndex) => {
        editor.removeToolbarItem(item);
        editor.insertToolbarItem({ groupIndex, itemIndex }, item);
      });
    });
    updateEditMode(currentEditMode);
    updateWordCount();
    updateCaretStatus();
    if (!findPanelEl.hidden) updateFindCount();
    readingTools?.refreshNow?.();
  }
  hideContextMenu();
  applyTheme(currentTheme, followsSystemTheme);
  updateTitle();
  setStatus(tr('status.languageSwitched'));
}

async function followSystemTheme() {
  followsSystemTheme = true;
  try {
    const sys = await window.api.getSystemTheme();
    window.api.setPreference({ theme: 'system' });
    applyTheme(sys, true);
    setStatus(sys === 'dark' ? tr('status.followSystemDark') : tr('status.followSystemLight'));
  } catch (_) {
    toast(tr('messages.systemThemeFailed'));
  }
}

function updateEditMode(mode) {
  currentEditMode = mode === 'markdown' ? 'markdown' : 'wysiwyg';
  const isMarkdown = currentEditMode === 'markdown';
  // 按钮图标指示“将切换到的模式”：源码 </> ，所见即所得 ✎。
  modeButtonEl.textContent = isMarkdown ? '✎' : '</>';
  modeButtonEl.title = isMarkdown
    ? tr('toolbar.switchToWysiwyg')
    : tr('toolbar.switchToSource');
  modeButtonEl.setAttribute('aria-label', isMarkdown ? tr('toolbar.switchToWysiwyg') : tr('toolbar.switchToSource'));
  setStatus(isMarkdown ? tr('status.sourceMode') : tr('status.wysiwygMode'));
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
    language: currentLanguage,
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
        currentFindMatch = -1;
        CSS.highlights.delete('search-current');
        if (!findPanelEl.hidden) updateFindCount();
        readingTools?.refresh();
        // Toast UI 在 changeMode 通知后仍会完成一次 code-block NodeView 更新。
        setTimeout(scheduleMermaidRender, 80);
      }
    }
  });
  instance.on('afterPreviewRender', () => { scheduleMermaidRender(); readingTools?.refresh(); });
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

function tr(key, values) {
  return i18n.t(currentLanguage, key, values);
}

function applyLanguageChrome() {
  document.documentElement.lang = currentLanguage;
  const text = {
    '#btn-new': tr('toolbar.new'),
    '#btn-open': tr('toolbar.open'),
    '#btn-save': tr('toolbar.save'),
    '.sidebar-title': tr('sidebar.files'),
    '#tab-files': tr('sidebar.files'),
    '#tab-outline': tr('sidebar.outline'),
    '#reading-settings h2': tr('settings.title'),
    'label[for="font-size"]': tr('settings.fontSize'),
    'label[for="line-width"]': tr('settings.lineWidth'),
    'label[for="theme-select"]': tr('settings.appearance'),
    'label[for="typewriter-toggle"]': `${tr('settings.typewriter')} <small>${tr('settings.keepCursorCentered')}</small>`,
    '#reading-settings p': tr('settings.hint'),
    '#btn-replace': tr('find.replace'),
    '#btn-replace-all': tr('find.replaceAll'),
    '#status-info': tr('ready'),
    '#word-count': tr('status.characters', { count: 0 }),
    '.drop-inner div:last-child': tr('messages.dropFile')
  };
  for (const [selector, value] of Object.entries(text)) {
    const element = document.querySelector(selector);
    if (element) element.innerHTML = value;
  }
  findInputEl.placeholder = tr('find.placeholder');
  replaceInputEl.placeholder = tr('find.replacePlaceholder');

  const titles = {
    '#btn-new': tr('toolbar.newTitle'),
    '#btn-open': tr('toolbar.openTitle'),
    '#btn-save': tr('toolbar.saveTitle'),
    '#btn-sidebar': tr('toolbar.sidebarTitle'),
    '#btn-find': tr('toolbar.findTitle'),
    '#btn-reading-settings': tr('toolbar.readingSettingsTitle'),
    '#btn-tree-up': tr('sidebar.upTitle'),
    '#btn-sidebar-refresh': tr('sidebar.refreshTitle'),
    '#reading-progress': tr('status.readingTitle'),
    '#cursor-pos': tr('status.cursorTitle'),
    '#reading-time': tr('status.readingTimeTitle'),
    '#zoom-level': tr('status.zoomTitle'),
    '#btn-find-prev': tr('find.previousTitle'),
    '#btn-find-next': tr('find.nextTitle'),
    '#btn-find-close': tr('find.closeTitle'),
    '#btn-find-expand': tr('find.expandTitle')
  };
  for (const [selector, value] of Object.entries(titles)) {
    const element = document.querySelector(selector);
    if (element) element.title = value;
  }

  const aria = {
    '#btn-sidebar': tr('toolbar.sidebarAria'),
    '#btn-find': tr('toolbar.findAria'),
    '#btn-focus': tr('toolbar.focusAria'),
    '#btn-theme': tr('toolbar.themeAria'),
    '#btn-reading-settings': tr('toolbar.readingSettingsAria'),
    '#file-sidebar': tr('sidebar.aria'),
    '#btn-tree-up': tr('sidebar.upAria'),
    '#btn-sidebar-refresh': tr('sidebar.refreshAria'),
    '.sidebar-tabs': tr('sidebar.tabsAria'),
    '#file-tree': tr('sidebar.treeAria'),
    '#outline-panel': tr('sidebar.outlineAria'),
    '#reading-settings': tr('toolbar.readingSettingsAria'),
    '#find-panel': tr('find.panelAria'),
    '#find-input': tr('find.aria'),
    '#replace-input': tr('find.replaceAria'),
    '#btn-find-prev': tr('find.previousAria'),
    '#btn-find-next': tr('find.nextAria'),
    '#btn-find-close': tr('find.closeAria'),
    '#btn-find-expand': tr('find.expandAria')
  };
  for (const [selector, value] of Object.entries(aria)) {
    const element = document.querySelector(selector);
    if (element) element.setAttribute('aria-label', value);
  }

  const fontOptions = document.querySelectorAll('#font-size option');
  const fontLabels = ['14 px', '16 px', '18 px', '20 px', '22 px'];
  fontOptions.forEach((option, index) => {
    if (index === 1) option.textContent = `16 px · ${tr('settings.comfortable')}`;
    else if (index === 3) option.textContent = `20 px · ${tr('settings.large')}`;
    else option.textContent = fontLabels[index];
  });
  const widthOptions = document.querySelectorAll('#line-width option');
  widthOptions.forEach((option, index) => {
    const labels = [
      `${tr('settings.narrow')} · 640 px`,
      `${tr('settings.standard')} · 780 px`,
      `${tr('settings.wide')} · 960 px`
    ];
    option.textContent = labels[index];
  });
  const themeOptions = document.querySelectorAll('#theme-select option');
  themeOptions.forEach((option) => {
    const labels = {
      system: tr('settings.system'),
      light: tr('settings.light'),
      cream: tr('settings.cream'),
      dark: tr('settings.dark')
    };
    option.textContent = labels[option.value];
  });
  document.querySelector('.case-option').lastChild.textContent = ` ${tr('find.caseSensitive')}`;

  if (!currentFilePath) filenameEl.textContent = tr('untitled');
  if (!fileTreeRootPath) {
    sidebarRootEl.textContent = tr('sidebar.noDocument');
    sidebarRootEl.title = tr('sidebar.noDocument');
  }
  fileTreeEl.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = tr(element.dataset.i18n, { error: element.dataset.error || '' });
  });
  fileTreeEl.querySelectorAll('.tree-directory > summary').forEach((summary) => {
    summary.title = `${summary.dataset.path}\n${tr('sidebar.enterFolder')}`;
    summary.querySelector('.tree-chevron').title = tr('sidebar.toggleFolder');
  });
  const outlineEmpty = outlineListEl.querySelector('.sidebar-empty');
  if (outlineEmpty) outlineEmpty.textContent = tr('sidebar.emptyOutline');
  codeCopyButton.textContent = tr('messages.copy');
  document.querySelectorAll('.mermaid-wysiwyg-preview').forEach((preview) => {
    preview.setAttribute('aria-label', tr('messages.mermaidDiagram'));
    if (preview.dataset.mermaidError === 'true') {
      preview.textContent = `${tr('messages.mermaidError')}\n${preview.dataset.mermaidSource || ''}`;
    }
  });
}

// WYSIWYG 的链接位于 contenteditable 的 ProseMirror 文档中，浏览器不会按普通
// 链接导航；预览列也统一走这里，避免同一次点击触发两条导航路径。
function headingSlug(text) {
  return String(text || '')
    .trim()
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function scrollToEditorAnchor(hash) {
  const active = editor?.isMarkdownMode()
    ? document.querySelector('.toastui-editor-md-preview .toastui-editor-contents')
    : document.querySelector('.toastui-editor-ww-container .ProseMirror');
  if (!active) return;

  let fragment = '';
  try {
    fragment = decodeURIComponent(hash.slice(1));
  } catch (_) {
    fragment = hash.slice(1);
  }
  const headings = [...active.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const target = active.querySelector(`[id="${CSS.escape(fragment)}"]`) ||
    headings.find((heading) => heading.id === fragment ||
      headingSlug(heading.textContent) === headingSlug(fragment) ||
      heading.textContent.trim() === fragment);
  target?.scrollIntoView({ block: 'start' });
}

function watchEditorLinks() {
  const openLink = (event) => {
    const link = event.target?.closest?.('a[href]');
    if (!link) return;

    let url;
    try {
      url = new URL(link.href);
    } catch (_) {
      return;
    }
    if ((link.getAttribute('href') || '').startsWith('#')) {
      event.preventDefault();
      scrollToEditorAnchor(url.hash);
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') return;

    event.preventDefault();
    window.api.openExternal(url.href).then((opened) => {
      if (!opened) toast(tr('messages.linkFailed'));
    });
  };

  const editorElement = document.getElementById('editor');
  editorElement.addEventListener('click', openLink, true);
  editorElement.addEventListener('auxclick', openLink, true);
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
  const name = currentFilePath ? baseName(currentFilePath) : tr('untitled');
  filenameEl.textContent = name;
  const suffix = currentLanguage === 'en-US' ? 'Markdown Reader' : 'Markdown阅读器';
  document.title = `${isDirty ? '• ' : ''}${name} - ${suffix}`;
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

function pathContains(rootPath, targetPath) {
  const root = comparablePath(rootPath).replace(/\/+$/, '');
  const target = comparablePath(targetPath).replace(/\/+$/, '');
  return Boolean(root) && (target === root || target.startsWith(`${root}/`));
}

function setSidebarCollapsed(collapsed, persist = true) {
  sidebarCollapsed = Boolean(collapsed);
  workspaceEl.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  document.getElementById('file-sidebar').inert = sidebarCollapsed || document.body.classList.contains('focus-mode');
  sidebarButtonEl.setAttribute('aria-expanded', String(!sidebarCollapsed));
  sidebarButtonEl.title = tr('toolbar.sidebarTitle');
  if (persist) {
    try {
      localStorage.setItem('md-reader.sidebarCollapsed', String(sidebarCollapsed));
    } catch (error) {
      console.warn('无法保存侧边栏状态:', error);
    }
  }
}

function clearFileTree(key = 'sidebar.emptyTree', error = '') {
  fileTreeEl.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'sidebar-empty';
  empty.dataset.i18n = key;
  empty.dataset.error = error;
  empty.textContent = tr(key, { error });
  fileTreeEl.appendChild(empty);
  sidebarRootEl.textContent = tr('sidebar.noDocument');
  sidebarRootEl.title = tr('sidebar.noDocument');
  fileTreeRootPath = null;
  fileTreeHomePath = null;
  sidebarUpButtonEl.hidden = true;
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
    summary.dataset.path = entry.path;
    summary.title = `${entry.path}\n${tr('sidebar.enterFolder')}`;
    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    chevron.textContent = '›';
    chevron.title = tr('sidebar.toggleFolder');
    chevron.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '▱';
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;
    summary.append(chevron, icon, name);
    summary.addEventListener('click', (event) => {
      if (event.target.closest('.tree-chevron')) return;
      event.preventDefault();
      void navigateFileTree(entry.path);
    });
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
  icon.textContent = '≡';
  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;
  button.append(icon, name);
  button.addEventListener('click', () => void openDocumentFromSidebar(entry.path));
  return button;
}

async function refreshFileTree(filePath = currentFilePath, rootPath = null) {
  if (!filePath) {
    fileTreeRequestId += 1;
    clearFileTree();
    return;
  }

  const keepCurrentRoot = !rootPath && fileTreeRootPath && pathContains(fileTreeRootPath, filePath);
  const requestPath = rootPath || (keepCurrentRoot ? fileTreeRootPath : filePath);
  if (!fileTreeHomePath || !pathContains(fileTreeHomePath, filePath)) {
    fileTreeHomePath = filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  }
  const requestId = ++fileTreeRequestId;
  sidebarRefreshButtonEl.classList.add('loading');
  try {
    const result = await window.api.listDirectoryForDocument(requestPath);
    if (requestId !== fileTreeRequestId) return;
    if (result.error) {
      clearFileTree('messages.directoryFailed', result.error);
      return;
    }

    fileTreeRootPath = result.rootPath;
    sidebarRootEl.textContent = result.rootName;
    sidebarRootEl.title = result.rootPath;
    sidebarUpButtonEl.hidden = !fileTreeHomePath ||
      !pathContains(fileTreeHomePath, fileTreeRootPath) ||
      comparablePath(fileTreeRootPath) === comparablePath(fileTreeHomePath);
    fileTreeEl.replaceChildren();
    const activePath = comparablePath(currentFilePath);
    result.entries.forEach((entry) => fileTreeEl.appendChild(createTreeEntry(entry, activePath)));

    if (result.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.dataset.i18n = 'sidebar.noFiles';
      empty.textContent = tr('sidebar.noFiles');
      fileTreeEl.appendChild(empty);
    } else if (result.truncated) {
      const notice = document.createElement('div');
      notice.className = 'sidebar-empty';
      notice.dataset.i18n = 'sidebar.truncated';
      notice.textContent = tr('sidebar.truncated');
      fileTreeEl.appendChild(notice);
    }
  } catch (error) {
    if (requestId === fileTreeRequestId) clearFileTree('messages.directoryFailed', error.message);
  } finally {
    if (requestId === fileTreeRequestId) sidebarRefreshButtonEl.classList.remove('loading');
  }
}

function navigateFileTree(rootPath) {
  if (!rootPath || rootPath === fileTreeRootPath) return Promise.resolve();
  return refreshFileTree(currentFilePath, rootPath);
}

function goUpFileTree() {
  if (!fileTreeRootPath || !fileTreeHomePath) return;
  const parentPath = fileTreeRootPath.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  if (!pathContains(fileTreeHomePath, parentPath)) return;
  void refreshFileTree(currentFilePath, parentPath);
}

async function openDocumentFromSidebar(filePath) {
  if (comparablePath(filePath) === comparablePath(currentFilePath)) return;
  if (!(await confirmBeforeReplace())) return;
  try {
    const result = await window.api.openPath(filePath);
    if (result.error) {
      toast(tr('messages.openFailed', { error: result.error }));
      void refreshFileTree(currentFilePath, fileTreeRootPath);
      return;
    }
    loadContent(result.filePath, result.content, result.baseUrl);
  } catch (error) {
    toast(tr('messages.openFailed', { error: error.message }));
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
    empty.textContent = tr('sidebar.emptyOutline');
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
      toast(tr('messages.headingUnavailable'));
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

function updateWordCount() {
  // 统计基于渲染正文（CJK 感知），由阅读模块负责计算与展示。
  readingTools?.refresh();
}

function updateCursorPos(pos) {
  if (!cursorPosEl) return;
  if (!pos) { cursorPosEl.textContent = ''; return; }
  const { line, col } = pos;
  cursorPosEl.textContent = tr('status.lineColumn', { line, column: col });
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
    toast(tr('messages.confirmReplaceFailed', { error: error.message }));
  }
  return false;
}

// 文档替换（新建/打开另一份文件）时重建编辑器：
// setMarkdown 的事务会留在撤销历史里，旧文档内容可能被 Ctrl+Z 带回新文档；
// 重建是清空历史最可靠的方式（主题切换不再重建，历史只在换文档时重置）。
function replaceEditorContent(content) {
  editor.destroy();
  editor = createEditor(content);
  window.editor = editor;
  CSS.highlights.delete('search-current');
  currentFindMatch = -1;
  lastFindSignature = '';
}

async function newDocument() {
  if (!(await confirmBeforeReplace())) return false;
  currentFilePath = null;
  fileTreeRequestId += 1;
  lastSavedContent = '';
  setDocumentBase(null);
  clearFileTree();
  replaceEditorContent('');
  findPanelEl.hidden = true;
  setDirty(false);
  updateTitle();
  updateWordCount();
  setStatus(tr('status.newBlank'));
  toast(tr('messages.newDocument'));
  window.api.stopWatchingDocument();
  discardSessionBackup();
  editor.focus();
  return true;
}

async function openFile() {
  try {
    const res = await window.api.openFile();
    if (res.canceled) return;
    if (res.error) { toast(tr('messages.openFailed', { error: res.error })); return; }
    if (!(await confirmBeforeReplace())) return;
    loadContent(res.filePath, res.content, res.baseUrl);
  } catch (error) {
    toast(tr('messages.openFailed', { error: error.message }));
  }
}

async function openSystemDocument(filePath) {
  if (!filePath || comparablePath(filePath) === comparablePath(currentFilePath)) return;
  if (!(await confirmBeforeReplace())) return;
  try {
    const result = await window.api.openPath(filePath);
    if (result.error) {
      toast(tr('messages.openFailed', { error: result.error }));
      return;
    }
    loadContent(result.filePath, result.content, result.baseUrl);
  } catch (error) {
    toast(tr('messages.openFailed', { error: error.message }));
  }
}

function loadContent(filePath, content, baseUrl) {
  currentFilePath = filePath || null;
  setDocumentBase(baseUrl);
  replaceEditorContent(content);
  // Toast UI 可能规范化末尾换行；以编辑器实际内容作为已保存基线，避免刚打开就误报修改。
  lastSavedContent = editor.getMarkdown();
  findPanelEl.hidden = true;
  setDirty(false);
  updateTitle();
  const displayName = filePath ? baseName(filePath) : tr('untitled');
  setStatus(tr('status.opened', { name: displayName }));
  if (filePath) {
    toast(tr('messages.opened', { name: displayName }));
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
    if (res.error) { toast(tr('messages.saveFailed', { error: res.error })); return false; }
    currentFilePath = res.filePath;
    lastSavedContent = content;
    setDocumentBase(res.baseUrl);
    setDirty(false);
    updateTitle();
    discardSessionBackup();
    if (options.silent) {
      setStatus(tr('status.autoSaved', { name: baseName(currentFilePath) }));
    } else {
      setStatus(tr('status.savedTo', { name: baseName(currentFilePath) }));
      toast(tr('messages.saved'));
    }
    if (!options.silent) void refreshFileTree(currentFilePath);
    return true;
  } catch (error) {
    toast(tr('messages.saveFailed', { error: error.message }));
    return false;
  } finally {
    saveInFlight = false;
  }
}

// ============ 图片插入 ============
async function handleImageInsert(blob, callback) {
  if (!blob) { callback(''); return; }
  if (!currentFilePath) {
    toast(tr('messages.saveImageFirst'));
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
    toast(tr('messages.saveImageFailed', { error: error.message }));
    callback('');
  }
}

// ============ 打印与导出 ============
async function printDocument() {
  try {
    setStatus(tr('status.preparingPrint'));
    const result = await window.api.printDocument(editor.getMarkdown());
    if (result && result.error) { toast(tr('messages.printFailed', { error: result.error })); return; }
    if (result && result.canceled) { setStatus(tr('status.printCanceled')); return; }
    setStatus(tr('status.printed'));
  } catch (error) {
    toast(tr('messages.printFailed', { error: error.message }));
  }
}

async function exportDocument(format) {
  try {
    const extension = format === 'pdf' ? 'pdf' : 'html';
    let suggestedPath = null;
    if (currentFilePath) {
      suggestedPath = currentFilePath.replace(/\.(md|markdown|mdown|txt)$/i, `.${extension}`);
    }
    setStatus(tr('status.exporting', { format: extension.toUpperCase() }));
    const result = await window.api.exportDocument(format, editor.getMarkdown(), suggestedPath);
    if (result && result.canceled) { setStatus(tr('status.exportCanceled')); return; }
    if (result && result.error) { toast(tr('messages.exportFailed', { error: result.error })); return; }
    toast(tr('messages.exported', { name: baseName(result.filePath) }));
    setStatus(tr('status.exported', { path: result.filePath }));
  } catch (error) {
    toast(tr('messages.exportFailed', { error: error.message }));
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

// Toast UI 3.x 两种模式的当前视图都提供 ProseMirror view（文档位置↔DOM 位置）。
// 将适配集中在这里；查找只读文档，高亮用 CSS Custom Highlight API，
// 不改写编辑器 DOM、不占用选区、不改变焦点。
function getSearchView() {
  return editor.getCurrentModeEditor().view;
}

// 基于当前模式的可见文本块收集匹配，返回 ProseMirror 文档区间 [from, to)。
// 所见即所得只匹配看得见的文字（不含链接地址等隐藏内容）；块边界天然隔断
// 跨块误匹配；图片、硬换行等叶子节点按占位符处理，不与相邻文字拼成命中。
function getFindMatches() {
  const expression = getFindExpression();
  if (!expression) return [];
  const matches = [];
  getSearchView().state.doc.descendants((block, blockPosition) => {
    if (!block.isTextblock) return true;
    let text = '';
    const positions = [];
    block.descendants((node, offset) => {
      if (node.isText) {
        for (let index = 0; index < node.text.length; index += 1) {
          text += node.text[index];
          positions.push(blockPosition + 1 + offset + index);
        }
      } else if (node.isLeaf) {
        text += '\ufffc'; // 图片、换行等节点不是相邻可搜索文字。
        positions.push(blockPosition + 1 + offset);
      }
    });
    for (const match of text.matchAll(expression)) {
      matches.push({ from: positions[match.index], to: positions[match.index + match[0].length - 1] + 1 });
    }
    return false;
  });
  return matches;
}

// 高亮当前匹配；reveal 时滚动到可视区（焦点可以在查找面板——PM 不会自己滚）。
function highlightFindMatch(match, reveal = false) {
  CSS.highlights.delete('search-current');
  if (!match || findPanelEl.hidden) return;
  const view = getSearchView();
  const start = view.domAtPos(match.from);
  const end = view.domAtPos(match.to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  CSS.highlights.set('search-current', new Highlight(range));
  if (!reveal) return;

  const root = view.dom;
  // 代码块等内部横向滚动区也需露出匹配文字。
  let parent = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer : range.startContainer.parentElement;
  while (parent && root.contains(parent)) {
    if (parent.scrollWidth > parent.clientWidth && /auto|scroll/.test(getComputedStyle(parent).overflowX)) {
      const rect = range.getBoundingClientRect();
      const bounds = parent.getBoundingClientRect();
      parent.scrollLeft += rect.left + rect.width / 2 - bounds.left - parent.clientWidth / 2;
    }
    if (parent === root) break;
    parent = parent.parentElement;
  }
  const rect = range.getBoundingClientRect();
  const bounds = root.getBoundingClientRect();
  const panel = findPanelEl.getBoundingClientRect();
  const visibleTop = panel.left < bounds.right && panel.right > bounds.left
    ? Math.max(bounds.top, panel.bottom + 16) : bounds.top;
  const visibleBottom = Math.min(bounds.bottom, window.innerHeight);
  root.scrollTop += rect.top + rect.height / 2 - (visibleTop + visibleBottom) / 2;
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

function updateFindCount() {
  const signature = `${currentEditMode}:${caseSensitiveEl.checked ? '1' : '0'}:${findInputEl.value}`;
  if (signature !== lastFindSignature) {
    lastFindSignature = signature;
    currentFindMatch = -1;
  }
  const matches = getFindMatches();
  const count = matches.length;
  if (currentFindMatch >= count) currentFindMatch = count - 1;
    findCountEl.textContent = currentFindMatch >= 0
      ? `${currentFindMatch + 1}/${count}`
      : tr('find.count', { count });
  findCountEl.classList.toggle('no-result', Boolean(findInputEl.value) && count === 0);
  highlightFindMatch(matches[currentFindMatch]);
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
  CSS.highlights.delete('search-current');
  editor.focus();
}

function findInEditor(backwards = false) {
  const query = findInputEl.value;
  if (!query) {
    showFindPanel();
    return false;
  }
  const matches = getFindMatches();
  const count = matches.length;
  if (count === 0) {
    findCountEl.textContent = tr('find.noMatch');
    findCountEl.classList.add('no-result');
    toast(tr('find.notFound'));
    return false;
  }
  currentFindMatch = backwards
    ? (currentFindMatch <= 0 ? count - 1 : currentFindMatch - 1)
    : (currentFindMatch + 1) % count;
  findCountEl.textContent = `${currentFindMatch + 1}/${count}`;
  findCountEl.classList.remove('no-result');
  highlightFindMatch(matches[currentFindMatch], true);
  return true;
}

// 替换基于当前视图的 ProseMirror 区间直接派发事务：
// 所见即所得只替换可见文字（不误伤隐藏的链接地址），整次操作单步可撤销，
// 滚动位置由 PM 自然保持，无需手动快照恢复。
function replaceCurrentMatch() {
  if (!findInputEl.value) return;
  const matches = getFindMatches();
  if (matches.length === 0) { toast(tr('find.notFound')); return; }
  if (currentFindMatch < 0 || currentFindMatch >= matches.length) currentFindMatch = 0;
  const replacedIndex = currentFindMatch;
  const match = matches[currentFindMatch];
  const view = getSearchView();
  view.dispatch(view.state.tr.insertText(replaceInputEl.value, match.from, match.to));
  currentFindMatch = replacedIndex - 1;
  updateFindCount();
  if (getFindMatches().length) findInEditor(false);
}

function replaceAllMatches() {
  if (!getFindExpression()) return;
  const matches = getFindMatches();
  if (matches.length === 0) {
    toast(tr('find.notFound'));
    return;
  }
  const view = getSearchView();
  const transaction = view.state.tr;
  // 从末尾替换，前面命中的位置保持有效；整次操作可一次撤销。
  [...matches].reverse().forEach((match) => transaction.insertText(replaceInputEl.value, match.from, match.to));
  view.dispatch(transaction);
  currentFindMatch = -1;
  updateFindCount();
    toast(tr('find.replaced', { count: matches.length }));
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
    toast(tr('messages.unsupportedFile'));
    return;
  }
  try {
    const res = await window.api.openPath(filePath);
    if (res.error) { toast(tr('messages.openFailed', { error: res.error })); return; }
    if (!(await confirmBeforeReplace())) return;
    loadContent(res.filePath, res.content, res.baseUrl);
  } catch (error) {
    toast(tr('messages.openFailed', { error: error.message }));
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
sidebarUpButtonEl.addEventListener('click', goUpFileTree);
sidebarRefreshButtonEl.addEventListener('click', () => void refreshFileTree(currentFilePath, fileTreeRootPath));
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
// 输入即跳转：每次修改查询都重新计数并滚动到首个命中，
// 不必按 Enter 才能看到定位（编辑器未聚焦时 PM 不会自己滚动）。
function findFromInput() {
  currentFindMatch = -1;
  if (updateFindCount()) findInEditor(false);
}
findInputEl.addEventListener('input', findFromInput);
caseSensitiveEl.addEventListener('change', findFromInput);
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
      case 'toggleFocus': readingTools?.toggleFocus(); break;
      case 'followSystemTheme': void followSystemTheme(); break;
      case 'setTheme':
        if (['light', 'cream', 'dark'].includes(payload.theme)) {
          followsSystemTheme = false;
          window.api.setPreference({ theme: payload.theme });
          applyTheme(payload.theme);
        }
        break;
      case 'setLanguage': setApplicationLanguage(String(payload.language || 'zh-CN')); break;
      case 'print': void printDocument(); break;
      case 'export': void exportDocument(payload.format === 'html' ? 'html' : 'pdf'); break;
      case 'autoSaveChanged': setAutoSaveEnabled(Boolean(payload.enabled)); break;
      case 'setFontSize':
        editorFontPrefs.size = Math.min(28, Math.max(12, Number(payload.size) || 16));
        window.api.setPreference({ editorFontSize: editorFontPrefs.size });
        applyEditorFontPrefs();
        setStatus(tr('status.fontSize', { size: editorFontPrefs.size }));
        break;
      case 'setFontFamily':
        if (Object.prototype.hasOwnProperty.call(FONT_FAMILY_VALUES, payload.family)) {
          editorFontPrefs.family = payload.family;
          window.api.setPreference({ editorFontFamily: editorFontPrefs.family });
          applyEditorFontPrefs();
          setStatus(tr('status.fontFamilyUpdated'));
        }
        break;
      case 'popup': openToolbarPopup(payload.name); break;
      case 'dateTime': editor.insertText('\n' + nowString() + '\n'); break;
      default: editor.exec(name, payload); break;
    }
  } catch (error) {
    console.warn('编辑命令失败:', name, error);
    toast(tr('messages.commandUnavailable'));
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
  toast(tr('messages.externalModified'));
  setStatus(tr('messages.externalModifiedStatus'));
});

// ============ 右键上下文菜单（成熟商业阅读器风格）============
function contextMenuItems() {
  return [
  { label: tr('context.undo'), hotkey: 'Ctrl+Z', action: () => editor.exec('undo') },
  { label: tr('context.redo'), hotkey: 'Ctrl+Shift+Z', action: () => editor.exec('redo') },
  { divider: true },
  { label: tr('context.cut'), hotkey: 'Ctrl+X', action: () => document.execCommand('cut') },
  { label: tr('context.copy'), hotkey: 'Ctrl+C', action: () => document.execCommand('copy') },
  { label: tr('context.paste'), hotkey: 'Ctrl+V', action: () => document.execCommand('paste') },
  { label: tr('context.selectAll'), hotkey: 'Ctrl+A', action: () => editor.exec('selectAll') },
  { divider: true },
  {
    label: tr('context.paragraph'), submenu: [
      { label: tr('context.text'), hotkey: 'Ctrl+0', action: () => editor.exec('heading', { level: 0 }) },
      ...Array.from({ length: 6 }, (_, index) => ({
        label: tr('context.headingLevel', { level: index + 1 }),
        hotkey: `Ctrl+${index + 1}`,
        action: () => editor.exec('heading', { level: index + 1 })
      })),
      { divider: true },
      { label: tr('context.blockQuote'), action: () => editor.exec('blockQuote') },
      { label: tr('context.bulletList'), action: () => editor.exec('bulletList') },
      { label: tr('context.orderedList'), action: () => editor.exec('orderedList') },
      { label: tr('context.taskList'), action: () => editor.exec('taskList') },
      { label: tr('context.codeBlock'), action: () => editor.exec('codeBlock') },
    ]
  },
  {
    label: tr('context.format'), submenu: [
      { label: tr('context.bold'), hotkey: 'Ctrl+B', action: () => editor.exec('bold') },
      { label: tr('context.italic'), hotkey: 'Ctrl+I', action: () => editor.exec('italic') },
      { label: tr('context.strike'), action: () => editor.exec('strike') },
      { label: tr('context.inlineCode'), action: () => editor.exec('code') },
      { divider: true },
      { label: tr('context.insertLink'), hotkey: 'Ctrl+K', action: () => openToolbarPopup('link') },
      { divider: true },
      { label: tr('context.indent'), action: () => editor.exec('indent') },
      { label: tr('context.outdent'), action: () => editor.exec('outdent') },
    ]
  },
  {
    label: tr('context.insert'), submenu: [
      { label: tr('context.image'), action: () => openToolbarPopup('image') },
      { label: tr('context.link'), hotkey: 'Ctrl+K', action: () => openToolbarPopup('link') },
      { label: tr('context.table'), action: () => openToolbarPopup('table') },
      { label: tr('context.codeBlock'), action: () => editor.exec('codeBlock') },
      { label: tr('context.horizontalRule'), action: () => editor.exec('hr') },
      { label: tr('context.dateTime'), action: () => editor.insertText('\n' + nowString() + '\n') },
    ]
  },
  { divider: true },
  { label: tr('context.find'), hotkey: 'Ctrl+F', action: () => showFindPanel(false) },
  { label: tr('context.replace'), hotkey: 'Ctrl+H', action: () => showFindPanel(true) },
  { label: tr('context.switchSource'), hotkey: 'Ctrl+/', action: () => toggleEditMode() },
  { label: tr('context.switchTheme'), hotkey: 'Ctrl+Shift+T', action: () => toggleTheme() },
  ];
}

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
      toast(tr('messages.insertUnavailable'));
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
  contextMenuEl = buildMenu(contextMenuItems(), false);
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
    if (storedPrefs && ['light', 'cream', 'dark'].includes(storedPrefs.theme)) {
      currentTheme = storedPrefs.theme;
      followsSystemTheme = false;
    } else {
      currentTheme = await window.api.getSystemTheme();
      followsSystemTheme = true;
    }
  } catch (e) { /* 默认 light */ }
  currentLanguage = storedPrefs && i18n.LANGUAGES.includes(storedPrefs.menuLanguage)
    ? storedPrefs.menuLanguage
    : 'zh-CN';
  applyLanguageChrome();
  setAutoSaveEnabled(Boolean(storedPrefs && storedPrefs.autoSave));
  editorFontPrefs = {
    size: (storedPrefs && Number(storedPrefs.editorFontSize)) || 16,
    family: (storedPrefs && storedPrefs.editorFontFamily) || '',
  };
  applyEditorFontPrefs();
  const readingLineWidth = (storedPrefs && Number(storedPrefs.readingLineWidth)) || 780;
  document.documentElement.style.setProperty('--reading-width', `${readingLineWidth}px`);
  const typewriterMode = Boolean(storedPrefs && storedPrefs.typewriterMode);
  document.body.classList.toggle('typewriter-mode', typewriterMode);
  applyTheme(currentTheme);
  setSidebarCollapsed(sidebarCollapsed, false);

  editor = createEditor('');
  window.editor = editor;
  readingTools = window.ReadingExperience.create({
    onSetFontSize: (size) => handleEditorCommand('setFontSize', { size }),
    onSetLineWidth: (width) => {
      document.documentElement.style.setProperty('--reading-width', `${width}px`);
      window.api.setPreference({ readingLineWidth: width });
      setStatus(tr('status.lineWidth', { width }));
    },
    onSetTypewriter: (enabled) => {
      document.body.classList.toggle('typewriter-mode', enabled);
      window.api.setPreference({ typewriterMode: enabled });
      setStatus(enabled ? tr('status.typewriterOn') : tr('status.typewriterOff'));
    },
    onSetTheme: (preference) => {
      if (preference === 'system') void followSystemTheme();
      else {
        followsSystemTheme = false;
        window.api.setPreference({ theme: preference });
        applyTheme(preference);
      }
    },
    getFontSize: () => editorFontPrefs.size,
    getTheme: () => (followsSystemTheme ? 'system' : currentTheme),
  });
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
  updateWordCount();
  updateTitle();
  setStatus(tr('status.newBlank'));
  setupContextMenu();
  watchEditorFocusLoss();
  watchEditorLinks();
  setupCodeCopyButtons();

  try {
    const startupDocument = await window.api.takeStartupDocument();
    if (startupDocument && !startupDocument.canceled) {
      if (startupDocument.error) toast(tr('messages.openStartupFailed', { error: startupDocument.error }));
      else loadContent(startupDocument.filePath, startupDocument.content, startupDocument.baseUrl);
    }
  } catch (error) {
    toast(tr('messages.readStartFailed', { error: error.message }));
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
        toast(tr('messages.restored'));
        setStatus(tr('messages.restoredStatus'));
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
codeCopyButton.textContent = tr('messages.copy');
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
      codeCopyButton.textContent = ok ? tr('messages.copied') : tr('messages.copyFailed');
      setTimeout(() => { codeCopyButton.textContent = tr('messages.copy'); }, 1200);
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
