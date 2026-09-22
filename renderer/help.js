'use strict';

(function () {
  const body = document.body;
  const navButtons = new Map([
    ['guide', document.getElementById('btn-guide')],
    ['about', document.getElementById('btn-about')]
  ]);
  const sections = new Map([
    ['guide', document.getElementById('guide')],
    ['about', document.getElementById('about')]
  ]);
  let systemTheme = 'light';
  let themePreference = 'system';
  let language = 'zh-CN';

  const HELP_TEXT = {
    'zh-CN': {
      asideAria: '帮助分区',
      guide: '操作说明',
      about: '关于应用',
      openSource: '开源许可',
      guideEyebrow: '操作说明',
      guideTitle: '让 Markdown 读起来更舒服',
      guideIntro: '从打开文件到长文阅读、编辑导出，这里按实际使用顺序整理了常用操作。快捷键以 Windows 菜单显示为准。',
      quickAria: '最快开始方式',
      quickTitle: '双击 .md 文件',
      quickSub: '或拖入窗口、按 Ctrl+O 打开',
      guideSections: [
        ['打开与多窗口', [
          ['打开文档', '双击 .md 文件、拖入窗口，或按 <kbd>Ctrl</kbd>+<kbd>O</kbd>。'],
          ['新建文档', '按 <kbd>Ctrl</kbd>+<kbd>N</kbd>；双击应用图标会打开未命名文档。'],
          ['并行阅读', '从资源管理器打开不同文件会创建新窗口；同一文档重复打开会聚焦既有窗口。'],
          ['新建空白窗口', '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>。']
        ]],
        ['浏览与导航', [
          ['文件侧边栏', '按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> 收起或展开，点击同目录文件切换。'],
          ['目录层级', '点击文件夹进入；左上角返回按钮回到上一级，刷新按钮重新读取目录。'],
          ['大纲', '按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> 打开，点击标题跳转，当前章节自动高亮。'],
          ['阅读进度', '底部状态栏显示百分比，滚动时跟随更新。']
        ]],
        ['阅读体验', [
          ['主题', '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> 循环浅色、奶油白和暗色，也可跟随系统。'],
          ['界面语言', '在“视图 → 界面语言”中切换中文 / English，偏好会自动保存。'],
          ['排版', '工具栏 Aa 打开设置，可调字号、正文宽度和正文字体。'],
          ['专注模式', '<kbd>F8</kbd> 进入，只保留当前段落清晰可读，<kbd>Esc</kbd> 退出。'],
          ['缩放', '<kbd>Ctrl</kbd>+滚轮、<kbd>Ctrl</kbd>+<kbd>=</kbd>、<kbd>Ctrl</kbd>+<kbd>-</kbd>，<kbd>Ctrl</kbd>+<kbd>0</kbd> 复位。']
        ]],
        ['编辑与查找', [
          ['编辑模式', '<kbd>Ctrl</kbd>+<kbd>/</kbd> 在所见即所得和 Markdown 源码间切换。'],
          ['查找', '<kbd>Ctrl</kbd>+<kbd>F</kbd> 输入即定位，<kbd>Enter</kbd>/<kbd>Shift</kbd>+<kbd>Enter</kbd> 跳转。'],
          ['替换', '<kbd>Ctrl</kbd>+<kbd>H</kbd> 展开替换，可单次或全部替换。'],
          ['图表', 'Mermaid 图表随文档渲染；悬停代码块可复制内容。']
        ]],
        ['保存与输出', [
          ['保存', '<kbd>Ctrl</kbd>+<kbd>S</kbd>；另存为使用 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>。'],
          ['自动保存', '在“查看”菜单开启；关闭前的未保存内容也有崩溃恢复保护。'],
          ['打印', '<kbd>Ctrl</kbd>+<kbd>P</kbd>。'],
          ['导出', '“文件 → 导出”生成 PDF 或单文件 HTML，图表一并输出。']
        ]],
        ['本地与安全', [
          ['数据位置', '文档保存在你选择的位置；偏好和最近记录保存在本机用户数据目录。'],
          ['外部修改', '检测到文件被其他程序修改时会提示，避免覆盖新内容。'],
          ['编码', '读取 UTF-8 和 UTF-16 文档，保存使用 UTF-8。'],
          ['便携版', '数据随程序目录保存，适合放入 U 盘或同步盘。'],
          ['版本更新', '自动检查每天最多一次；也可在“帮助 → 检查更新…”手动检查。应用只提示，不自动下载安装。']
        ]]
      ],
      aboutEyebrow: 'Markdown阅读器',
      aboutTitle: '专注本地阅读的 Markdown 工作台',
      aboutIntro: '面向日常笔记、技术文档和长篇书稿，把即时渲染、清晰排版、长文导航和可靠保存放进一个轻量桌面应用。',
      facts: ['版本', '界面', '数据方式', '许可证'],
      interface: '中文 / English · 浅色、奶油白、深色',
      localFirst: '本地优先',
      coreTitle: '核心体验',
      qualityTitle: '工程质量',
      core: [
        ['阅读优先', '居中正文列、可调宽度和字号、进度与阅读时间。'],
        ['长文导航', '大纲跟随章节，文件侧边栏在同一目录内切换。'],
        ['沉浸工作', '专注模式淡化无关内容，打字机模式保持光标居中。'],
        ['多窗口', '不同文件夹的文档可以同时打开，互不替换。']
      ],
      quality: [
        ['编辑可靠', '未保存保护、外部修改提醒、可选自动保存和崩溃恢复。'],
        ['输出完整', '打印、PDF 和单文件 HTML 保留图表与排版。'],
        ['来源清楚', '直接依赖、锁定版本和许可证清单随仓库维护。'],
        ['更新提示', '定时读取 GitHub 稳定发布信息，发现新版本时提醒你查看发布页。'],
        ['可验证', '阅读、搜索、链接、侧栏、帮助页和更新检查均有回归测试。']
      ],
      provenanceTitle: '开源组件',
      provenance: '本项目使用 Electron、Toast UI Editor、Mermaid 与 PrismJS 构建运行能力；体验定位接近成熟商业产品，未复制闭源商业产品代码。完整组件、版本、上游项目和许可证信息见仓库中的 <code>THIRD_PARTY_NOTICES.md</code> 与 <code>THIRD_PARTY_LICENSES.md</code>。',
      guideDocumentTitle: 'Markdown阅读器帮助',
      aboutDocumentTitle: '关于 Markdown阅读器'
    },
    'en-US': {
      asideAria: 'Help sections',
      guide: 'User Guide',
      about: 'About',
      openSource: 'Open Source',
      guideEyebrow: 'User Guide',
      guideTitle: 'Make Markdown easier to read',
      guideIntro: 'Common tasks are organized in the order you use them, from opening files to reading, editing, and exporting. Shortcuts follow the Windows menu labels.',
      quickAria: 'Fastest way to start',
      quickTitle: 'Double-click a .md file',
      quickSub: 'Or drag it into the window or press Ctrl+O',
      guideSections: [
        ['Open & Windows', [
          ['Open a document', 'Double-click a .md file, drag it into the window, or press <kbd>Ctrl</kbd>+<kbd>O</kbd>.'],
          ['New document', 'Press <kbd>Ctrl</kbd>+<kbd>N</kbd>; launching the app opens an untitled document.'],
          ['Parallel reading', 'Opening another file from Explorer creates a new window; opening the same file focuses its existing window.'],
          ['New blank window', '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>.']
        ]],
        ['Browse & Navigate', [
          ['File sidebar', 'Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> to collapse or expand it; click a file in the same directory to switch.'],
          ['Directory levels', 'Click a folder to enter it; use the top-left back button for the parent directory and refresh to reload.'],
          ['Outline', 'Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>, click a heading to jump, and watch the current section stay highlighted.'],
          ['Reading progress', 'The status bar shows a percentage that updates while you scroll.']
        ]],
        ['Reading Experience', [
          ['Theme', '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> cycles Light, Cream White, and Dark; you can also follow the system.'],
          ['Interface language', 'Switch Chinese / English from “View → Interface Language”; the preference is saved automatically.'],
          ['Typography', 'Open the Aa settings to change font size, body width, and body font.'],
          ['Focus mode', 'Press <kbd>F8</kbd> to keep only the current paragraph clear; press <kbd>Esc</kbd> to exit.'],
          ['Zoom', '<kbd>Ctrl</kbd>+wheel, <kbd>Ctrl</kbd>+<kbd>=</kbd>, or <kbd>Ctrl</kbd>+<kbd>-</kbd>; <kbd>Ctrl</kbd>+<kbd>0</kbd> resets.']
        ]],
        ['Edit & Find', [
          ['Editing mode', 'Press <kbd>Ctrl</kbd>+<kbd>/</kbd> to switch between WYSIWYG and Markdown source.'],
          ['Find', 'Press <kbd>Ctrl</kbd>+<kbd>F</kbd>; results locate as you type, with <kbd>Enter</kbd>/<kbd>Shift</kbd>+<kbd>Enter</kbd> navigation.'],
          ['Replace', 'Press <kbd>Ctrl</kbd>+<kbd>H</kbd> to expand replace; replace one match or all.'],
          ['Diagrams', 'Mermaid diagrams render with the document; hover a code block to copy it.']
        ]],
        ['Save & Output', [
          ['Save', '<kbd>Ctrl</kbd>+<kbd>S</kbd>; use <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> for Save As.'],
          ['Auto Save', 'Enable it in the View menu; unsaved content also has crash-recovery protection before shutdown.'],
          ['Print', '<kbd>Ctrl</kbd>+<kbd>P</kbd>.'],
          ['Export', 'Use File → Export for PDF or single-file HTML, including diagrams.']
        ]],
        ['Local & Safety', [
          ['Data location', 'Documents stay where you save them; preferences and recent files stay in local user data.'],
          ['External changes', 'The app warns when another program changes the file, preventing accidental overwrites.'],
          ['Encoding', 'Reads UTF-8 and UTF-16 documents; saves as UTF-8.'],
          ['Portable edition', 'Data stays beside the program directory, suitable for USB drives or synced folders.'],
          ['Version updates', 'Automatic checks run at most once per day; manual checks are available in Help → Check for Updates…. The app only notifies and never downloads or installs updates.']
        ]]
      ],
      aboutEyebrow: 'Markdown阅读器',
      aboutTitle: 'A local-first Markdown workspace',
      aboutIntro: 'For everyday notes, technical documents, and long manuscripts, it brings instant rendering, clear typography, long-document navigation, and reliable saving into one lightweight desktop app.',
      facts: ['Version', 'Interface', 'Data', 'License'],
      interface: 'Chinese / English · Light, cream & dark',
      localFirst: 'Local first',
      coreTitle: 'Core Experience',
      qualityTitle: 'Engineering Quality',
      core: [
        ['Reading first', 'Centered body column, adjustable width and font size, progress and reading time.'],
        ['Long-document navigation', 'The outline follows sections; the file sidebar switches within the same directory.'],
        ['Immersive work', 'Focus mode fades unrelated content; typewriter mode keeps the cursor centered.'],
        ['Multiple windows', 'Documents in different folders can stay open without replacing one another.']
      ],
      quality: [
        ['Reliable editing', 'Unsaved-change protection, external-change prompts, optional auto-save, and crash recovery.'],
        ['Complete output', 'Print, PDF, and single-file HTML retain diagrams and typography.'],
        ['Clear provenance', 'Direct dependencies, locked versions, and license inventories are maintained in the repository.'],
        ['Update notices', 'Reads GitHub stable releases periodically and prompts you when a newer version is available.'],
        ['Verifiable', 'Reading, search, links, sidebar, help, and update checks have regression tests.']
      ],
      provenanceTitle: 'Open Source',
      provenance: 'This project uses Electron, Toast UI Editor, Mermaid, and PrismJS for its runtime capabilities. Its experience aims toward mature commercial quality without copying closed-source commercial product code. Full components, versions, upstream projects, and licenses are in <code>THIRD_PARTY_NOTICES.md</code> and <code>THIRD_PARTY_LICENSES.md</code>.',
      guideDocumentTitle: 'Markdown Reader Help',
      aboutDocumentTitle: 'About Markdown Reader'
    }
  };

  function currentTheme() {
    return themePreference === 'system' ? systemTheme : themePreference;
  }

  function applyTheme() {
    const theme = currentTheme();
    document.body.classList.remove('theme-light', 'theme-cream', 'theme-dark');
    body.classList.toggle('theme-light', theme === 'light');
    body.classList.toggle('theme-cream', theme === 'cream');
    body.classList.toggle('theme-dark', theme === 'dark');
  }

  function selectSection(section, shouldFocus = false) {
    const next = sections.has(section) ? section : 'guide';
    for (const [name, element] of sections) element.hidden = name !== next;
    for (const [name, button] of navButtons) {
      const active = name === next;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    body.dataset.section = next;
    document.title = next === 'about'
      ? HELP_TEXT[language].aboutDocumentTitle
      : HELP_TEXT[language].guideDocumentTitle;
    if (shouldFocus) navButtons.get(next).focus();
    else document.querySelector('.help-main').scrollTop = 0;
  }

  function applyState(state) {
    if (!state) return;
    if (state.systemTheme === 'light' || state.systemTheme === 'dark') systemTheme = state.systemTheme;
    if (['system', 'light', 'cream', 'dark'].includes(state.themePreference)) {
      themePreference = state.themePreference;
    }
    if (state.version) {
      document.getElementById('help-version').textContent = `v${state.version}`;
      document.getElementById('about-version').textContent = state.version;
    }
    if (state.menuLanguage === 'zh-CN' || state.menuLanguage === 'en-US') {
      language = state.menuLanguage;
    }
    applyHelpLanguage();
    applyTheme();
  }

  function applyHelpLanguage() {
    const text = HELP_TEXT[language];
    document.title = body.dataset.section === 'about' ? text.aboutDocumentTitle : text.guideDocumentTitle;
    document.documentElement.lang = language;
    document.querySelector('.help-aside').setAttribute('aria-label', text.asideAria);
    navButtons.get('guide').textContent = text.guide;
    navButtons.get('about').textContent = text.about;
    document.getElementById('open-source-link').textContent = text.openSource;

    document.querySelector('#guide .eyebrow').textContent = text.guideEyebrow;
    document.getElementById('guide-title').textContent = text.guideTitle;
    document.querySelector('#guide .guide-header p:not(.eyebrow)').textContent = text.guideIntro;
    document.querySelector('.quick-start').setAttribute('aria-label', text.quickAria);
    document.querySelector('.quick-start strong').textContent = text.quickTitle;
    document.querySelector('.quick-start div > span:not(.quick-icon)').textContent = text.quickSub;
    document.querySelectorAll('.guide-card').forEach((card, cardIndex) => {
      const [title, rows] = text.guideSections[cardIndex];
      card.querySelector('h2').textContent = title;
      card.querySelectorAll('dl > div').forEach((row, rowIndex) => {
        const [term, description] = rows[rowIndex];
        row.querySelector('dt').textContent = term;
        row.querySelector('dd').innerHTML = description;
      });
    });

    document.querySelector('#about .eyebrow').textContent = text.aboutEyebrow;
    document.getElementById('about-title').textContent = text.aboutTitle;
    document.querySelector('.about-header > div > p:not(.eyebrow)').textContent = text.aboutIntro;
    document.querySelectorAll('.fact-strip > div > span').forEach((element, index) => {
      element.textContent = text.facts[index];
    });
    document.querySelector('.fact-strip > div:nth-child(2) strong').textContent = text.interface;
    document.querySelector('.fact-strip > div:nth-child(3) strong').textContent = text.localFirst;
    document.querySelector('.about-columns .about-block:first-child h2').textContent = text.coreTitle;
    document.querySelector('.about-columns .about-block:last-child h2').textContent = text.qualityTitle;
    document.querySelectorAll('.about-columns .about-block:first-child li').forEach((item, index) => {
      const [term, description] = text.core[index];
      item.innerHTML = `<strong>${term}</strong>: ${description}`;
    });
    document.querySelectorAll('.about-columns .about-block:last-child li').forEach((item, index) => {
      const [term, description] = text.quality[index];
      item.innerHTML = `<strong>${term}</strong>: ${description}`;
    });
    document.querySelector('.provenance h2').textContent = text.provenanceTitle;
    document.querySelector('.provenance p').innerHTML = text.provenance;
  }

  for (const [name, button] of navButtons) {
    button.addEventListener('click', () => selectSection(name));
  }

  document.getElementById('open-source-link').addEventListener('click', async (event) => {
    event.preventDefault();
    await window.api.openExternal(event.currentTarget.href);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    selectSection('guide');
  });

  window.api.onHelpSectionChanged((state) => selectSection(state?.section));
  window.api.onHelpStateChanged(applyState);
  window.api.onSystemThemeChanged((theme) => {
    if (theme === 'light' || theme === 'dark') {
      systemTheme = theme;
      applyTheme();
    }
  });

  window.helpApi = {
    selectSection,
    getState: () => ({
      themePreference,
      language,
      systemTheme,
      renderedTheme: currentTheme(),
      activeSection: body.dataset.section,
      title: document.title
    })
  };

  selectSection('guide');
  window.api.getHelpState().then(applyState).catch(() => applyTheme());
})();
