'use strict';

// 阅读辅助：专注模式、打字机滚动、阅读进度、CJK 感知字数与阅读时长。
// 只消费编辑器的渲染结果，不改写 Markdown，也不向文档插入导航标记。
// 偏好通过主进程 preferences.json 持久化（与字号/字体同一事实源）。
window.ReadingExperience = (() => {
  const byId = (id) => document.getElementById(id);
  const language = () => (document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN');
  const tr = (key, values) => window.AppI18n.t(language(), key, values);

  // 编辑器实例可能因文档替换而重建，一律通过 window.editor 动态取用。
  function create({
    onSetFontSize,      // (px:number) => void —— 接入 editorFontSize 偏好
    onSetLineWidth,     // (px:640|780|960) => void
    onSetTypewriter,    // (enabled:boolean) => void
    onSetTheme,         // ('system'|'light'|'dark') => void
    getFontSize,        // () => number 当前字号（用于同步下拉框）
    getTheme,           // () => 'system'|'light'|'dark'
  }) {
    const editorElement = byId('editor');
    const currentEditor = () => window.editor;
    const settings = byId('reading-settings');
    const settingsButton = byId('btn-reading-settings');
    const focusStyle = document.createElement('style');
    document.head.appendChild(focusStyle);
    let refreshTimer;
    let scrollFrame;
    let focusFrame;
    let focusMode = false;

    // ---------- 排版设置弹出层 ----------
    function syncSettingsControls() {
      const sizes = byId('font-size');
      const current = String(getFontSize());
      if (![...sizes.options].some((option) => option.value === current)) {
        const extra = document.createElement('option');
        extra.value = current;
        extra.textContent = `${current} px`;
        sizes.appendChild(extra);
      }
      sizes.value = current;
      byId('line-width').value = String(document.documentElement.style.getPropertyValue('--reading-width').replace(/px.*/, '').trim() || '780');
      byId('theme-select').value = getTheme();
      byId('typewriter-toggle').checked = document.body.classList.contains('typewriter-mode');
    }

    byId('font-size').addEventListener('change', () => onSetFontSize(Number(byId('font-size').value)));
    byId('line-width').addEventListener('change', () => onSetLineWidth(Number(byId('line-width').value)));
    byId('typewriter-toggle').addEventListener('change', () => onSetTypewriter(byId('typewriter-toggle').checked));
    byId('theme-select').addEventListener('change', () => onSetTheme(byId('theme-select').value));

    function closeSettings(restoreFocus = false) {
      settings.hidden = true;
      settingsButton.setAttribute('aria-expanded', 'false');
      if (restoreFocus) settingsButton.focus();
    }
    settingsButton.addEventListener('click', () => {
      if (settings.hidden) {
        syncSettingsControls();
        settings.hidden = false;
        settingsButton.setAttribute('aria-expanded', 'true');
        byId('font-size').focus();
      } else {
        closeSettings();
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!settings.hidden && !settings.contains(event.target) && !settingsButton.contains(event.target)) closeSettings();
    });
    document.addEventListener('focusin', (event) => {
      if (!settings.hidden && !settings.contains(event.target) && !settingsButton.contains(event.target)) closeSettings();
    });

    // ---------- 滚动容器 ----------
    // 滚动可能发生在 ww 的 .ProseMirror、源码模式编辑器或预览列上；
    // 向上查找真正带滚动条的祖先，与 app.js 的查找滚动逻辑保持一致。
    function scrollContainers() {
      const roots = Array.from(editorElement.querySelectorAll('.ProseMirror, .toastui-editor-md-preview'))
        .filter((el) => el.offsetParent !== null);
      const scrollers = new Set();
      for (const root of roots) {
        let node = root;
        while (node && node !== document.body) {
          if (node.scrollHeight > node.clientHeight + 4 &&
              /(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
            scrollers.add(node);
            break;
          }
          node = node.parentElement;
        }
        if (node === document.body || !node) scrollers.add(root);
      }
      return [...scrollers];
    }

    // ---------- 阅读进度 ----------
    function updatePosition() {
      const containers = scrollContainers();
      let progress = 100;
      for (const scroller of containers) {
        const extent = scroller.scrollHeight - scroller.clientHeight;
        const current = extent > 1 ? Math.round(scroller.scrollTop / extent * 100) : 100;
        progress = Math.min(progress, Math.max(0, current));
      }
      const el = byId('reading-progress');
      if (el) {
        el.textContent = `${Math.min(100, progress)}%`;
        el.title = tr('status.readingTitle');
      }
    }
    editorElement.addEventListener('scroll', () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(updatePosition);
    }, true);
    window.addEventListener('resize', updatePosition);

    // ---------- 专注模式 ----------
    function contentRoot() {
      return editorElement.querySelector(currentEditor().isMarkdownMode()
        ? '.toastui-editor-md-container .ProseMirror'
        : '.toastui-editor-ww-container .ProseMirror');
    }

    function toggleFocus(force) {
      focusMode = typeof force === 'boolean' ? force : !focusMode;
      if (!focusMode) { focusStyle.textContent = ''; delete editorElement.dataset.focusedBlock; }
      document.body.classList.toggle('focus-mode', focusMode);
      const sidebar = byId('file-sidebar');
      if (sidebar) sidebar.inert = focusMode || byId('workspace').classList.contains('sidebar-collapsed');
      const button = byId('btn-focus');
      if (button) {
        button.setAttribute('aria-pressed', String(focusMode));
        button.classList.toggle('active', focusMode);
        button.title = focusMode ? tr('toolbar.exitFocus') : tr('toolbar.focusTitle');
        button.setAttribute('aria-label', focusMode ? tr('toolbar.exitFocus') : tr('toolbar.focusAria'));
      }
      updateFocusedBlock(false);
      requestAnimationFrame(updatePosition);
    }
    byId('btn-focus')?.addEventListener('click', () => toggleFocus());
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!settings.hidden) { closeSettings(true); event.preventDefault(); }
      else if (focusMode && byId('find-panel').hidden && !document.querySelector('.ctx-menu')) toggleFocus(false);
    });

    function updateFocusedBlock(center) {
      const root = contentRoot();
      if (!root) return;
      let node = window.getSelection()?.anchorNode;
      if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
      if (!node || !root.contains(node)) return;
      while (node.parentElement && node.parentElement !== root) node = node.parentElement;
      if (node === root) return;
      // 不改 ProseMirror 子节点属性：其 DOMObserver 会回滚属性，甚至生成文档事务。
      if (focusMode) {
        const index = Array.from(root.children).indexOf(node) + 1;
        editorElement.dataset.focusedBlock = String(index);
        const modeClass = currentEditor().isMarkdownMode() ? 'md' : 'ww';
        const selector = `body.focus-mode #editor .toastui-editor-${modeClass}-container .ProseMirror > :not(:nth-child(${index}))`;
        const rule = `${selector} { opacity: 0.32; }`;
        if (focusStyle.textContent !== rule) focusStyle.textContent = rule;
      }
      if (center && document.body.classList.contains('typewriter-mode') && root.contains(document.activeElement)) {
        const selection = window.getSelection();
        const range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        if (range) {
          range.collapse(false);
          const rect = range.getClientRects()[0] || node.getBoundingClientRect();
          const scroller = scrollContainers()[0];
          if (scroller) {
            const bounds = scroller.getBoundingClientRect();
            scroller.scrollTop += rect.top + rect.height / 2 - bounds.top - scroller.clientHeight / 2;
          }
        }
      }
    }
    document.addEventListener('selectionchange', () => {
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => updateFocusedBlock(true));
    });
    editorElement.addEventListener('keyup', () => updateFocusedBlock(true));

    // ---------- 字数统计与阅读时长（基于渲染正文） ----------
    function refresh() {
      const template = document.createElement('template');
      // getHTML() 在源码模式会重写隐藏的 WYSIWYG 文档；读取已完成的预览，避免污染撤销历史。
      const active = currentEditor();
      template.innerHTML = active.isMarkdownMode()
        ? editorElement.querySelector('.toastui-editor-md-preview .toastui-editor-contents')?.innerHTML || ''
        : active.getHTML();
      template.content.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      template.content.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,pre,td,th').forEach((block) => block.append('\n'));
      const text = template.content.textContent || '';
      const characters = Array.from(text.replace(/\s/g, '')).length;
      const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
      const words = (text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ')
        .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
      byId('word-count').textContent = tr('status.characters', {
        count: characters.toLocaleString(language())
      });
      byId('word-count').title = tr('status.wordCountTitle', { cjk, words });
      byId('reading-time').textContent = tr('status.minutes', {
        count: characters ? Math.max(1, Math.ceil(cjk / 400 + words / 200)) : 0
      });
      byId('reading-time').title = tr('status.readingTimeEstimate');
      const focusButton = byId('btn-focus');
      if (focusButton) {
        focusButton.title = focusMode ? tr('toolbar.exitFocus') : tr('toolbar.focusTitle');
        focusButton.setAttribute('aria-label', focusMode ? tr('toolbar.exitFocus') : tr('toolbar.focusAria'));
      }
      updatePosition();
      updateFocusedBlock(false);
    }
    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 180);
    }
    editorElement.addEventListener('load', updatePosition, true);

    refresh();
    return {
      toggleFocus,
      refresh: scheduleRefresh,
      refreshNow: refresh,
      syncSettingsControls,
    };
  }
  return { create };
})();
