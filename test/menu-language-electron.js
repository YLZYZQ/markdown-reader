'use strict';

// 主进程回归：菜单语言即时切换，主题菜单能把主编辑器切到奶油白并持久化。

const { app, BrowserWindow, Menu, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-menu-language-'));
const userData = path.join(portableRoot, 'data');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'preferences.json'), JSON.stringify({
  menuLanguage: 'zh-CN', editorFontSize: 20, updateCheckEnabled: false
}));
app.setPath('userData', path.join(portableRoot, 'other-profile'));
process.env.PORTABLE_EXECUTABLE_DIR = portableRoot;
app.getVersion = () => require('../package.json').version;
app.commandLine.appendSwitch('disable-gpu');

require('../main.js');

const timeout = setTimeout(() => {
  console.error('Menu language test timed out');
  app.exit(1);
}, 30000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForPreference(language) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8'));
    if (stored.menuLanguage === language) return stored;
    await wait(50);
  }
  assert.fail(`Language preference was not persisted: ${language}`);
}
async function waitForEditor(win) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await win.webContents.executeJavaScript('Boolean(window.editor)')) return;
    await wait(50);
  }
  assert.fail('Renderer initialization timed out');
}

function findMenuItem(items, label) {
  for (const item of items) {
    if (item.label === label) return item;
    if (item.submenu) {
      const found = findMenuItem(item.submenu.items, label);
      if (found) return found;
    }
  }
  return null;
}

function topLabels() {
  return Menu.getApplicationMenu().items.map((item) => item.label);
}

async function snapshot(win) {
  return win.webContents.executeJavaScript(`(() => ({
    language: document.documentElement.lang,
    markdown: window.editor.getMarkdown(),
    sameEditor: window.editor === window.languageTestEditor,
    selection: window.editor.getSelection(),
    scroll: window.editor.getCurrentModeEditor().view.dom.scrollTop,
    dirty: document.title.startsWith('• '),
    mode: window.editor.isMarkdownMode(),
    open: document.querySelector('#btn-open').textContent,
    files: document.querySelector('#tab-files').textContent,
    outline: document.querySelector('#tab-outline').textContent,
    root: document.querySelector('#sidebar-root').textContent,
    find: document.querySelector('#find-input').placeholder,
    replace: document.querySelector('#replace-input').placeholder,
    count: document.querySelector('#find-count').textContent,
    settings: document.querySelector('#reading-settings h2').textContent,
    theme: document.querySelector('#btn-theme').title,
    bold: document.querySelector('.toastui-editor-toolbar-icons.bold').getAttribute('aria-label'),
    words: document.querySelector('#word-count').textContent,
    iconLoaded: document.querySelector('.file-icon').naturalWidth > 0
  }))()`);
}

async function prepareEdit(win, mode) {
  await win.webContents.executeJavaScript(`(() => {
    window.editor.changeMode(${JSON.stringify(mode)});
    window.languageTestEditor = window.editor;
    const view = window.editor.getCurrentModeEditor().view;
    const position = window.editor.isMarkdownMode() ? 3 : 2;
    view.dispatch(view.state.tr.insertText('LANGUAGE_EDIT', position));
    view.dom.scrollTop = 420;
    document.querySelector('#btn-find').click();
    document.querySelector('#btn-reading-settings').click();
  })()`);
  await wait(250);
  return snapshot(win);
}

function assertPreserved(before, after) {
  assert.equal(after.sameEditor, true, 'Language switch replaced editor');
  assert.equal(after.markdown, before.markdown);
  assert.deepEqual(after.selection, before.selection);
  assert.equal(after.scroll, before.scroll);
  assert.equal(after.dirty, before.dirty);
  assert.equal(after.mode, before.mode);
  assert.equal(after.root, before.root);
}

async function assertUndo(win) {
  const result = await win.webContents.executeJavaScript(`(() => {
    const edited = window.editor.getMarkdown();
    window.editor.exec('undo');
    const undone = window.editor.getMarkdown();
    window.editor.exec('redo');
    return { edited, undone, redone: window.editor.getMarkdown() };
  })()`);
  assert.notEqual(result.undone, result.edited, 'Undo history was lost');
  assert.equal(result.redone, result.edited, 'Redo history was lost');
}

app.whenReady().then(async () => {
  try {
    await wait(900);
    assert(topLabels().includes('文件'), JSON.stringify(topLabels()));

    const menu = Menu.getApplicationMenu();
    const english = findMenuItem(menu.items, 'English');
    const window = BrowserWindow.getAllWindows()[0];
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.style.getPropertyValue("--md-reader-font-size")'), '20px', 'Portable preferences must be read after selecting the data directory');
    const errors = [];
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push(message);
    });
    const fixture = path.join(userData, 'language-test.md');
    fs.writeFileSync(fixture, '# 语言测试\n\n' + 'English and 中文 document content.\n\n'.repeat(100));
    const dialogs = [];
    dialog.showOpenDialog = async (_parent, options) => {
      dialogs.push(options);
      return { canceled: false, filePaths: [fixture] };
    };
    await window.webContents.executeJavaScript('document.querySelector("#btn-open").click()');
    await wait(350);
    assert.equal(dialogs[0].title, '打开 Markdown 文件');
    const beforeEnglish = await prepareEdit(window, 'wysiwyg');
    assert(beforeEnglish.iconLoaded, 'App icon must load after the document base URL changes');
    assert(beforeEnglish.scroll > 0, 'Fixture must be scrolled');
    assert(english, 'English menu item not found');
    english.click(english, window, {});
    await wait(120);
    assert(topLabels().includes('File'), JSON.stringify(topLabels()));
    assert(topLabels().includes('View'), JSON.stringify(topLabels()));
    const englishState = await snapshot(window);
    assertPreserved(beforeEnglish, englishState);
    assert.equal(englishState.language, 'en-US');
    assert.equal(englishState.open, 'Open');
    assert.equal(englishState.files, 'Files');
    assert.equal(englishState.outline, 'Outline');
    assert.equal(englishState.find, 'Find');
    assert.equal(englishState.replace, 'Replace with');
    assert.equal(englishState.bold, 'Bold');
    assert.match(englishState.theme, /Switch theme/i);
    assert.match(englishState.words, /characters/);
    assert.match(englishState.count, /matches/);
    assert.equal(englishState.settings, 'Reading & Typography');
    await assertUndo(window);

    // Popup labels and tooltips are cached by Toast UI independently of app chrome.
    const popup = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('.toastui-editor-toolbar-icons.link').click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return document.querySelector('.toastui-editor-popup-add-link').innerText;
    })()`);
    assert.match(popup, /Link text/);
    assert.match(popup, /Cancel/);
    await window.webContents.executeJavaScript('window.api.openFile()');
    assert.equal(dialogs.at(-1).title, 'Open Markdown File');

    const helpItem = findMenuItem(Menu.getApplicationMenu().items, 'About Markdown Reader');
    assert(helpItem, 'About menu item missing');
    helpItem.click(helpItem, window, {});
    await wait(350);
    const help = BrowserWindow.getAllWindows().find(win => win.id !== window.id);
    assert(help, 'Help window missing');
    assert.equal(await help.webContents.executeJavaScript('document.documentElement.lang'), 'en-US');
    assert.match(await help.webContents.executeJavaScript('document.title'), /About/);
    assert.match(await help.webContents.executeJavaScript('document.querySelector("#about").innerText'), /Core Experience/);
    assert.equal(await help.webContents.executeJavaScript('[...document.querySelectorAll("img")].filter(img => img.complete && img.naturalWidth > 0).length'), 3);

    const secondDirectory = path.join(userData, 'second');
    fs.mkdirSync(secondDirectory);
    const secondFile = path.join(secondDirectory, 'second.md');
    fs.writeFileSync(secondFile, '# Second window');
    app.emit('second-instance', {}, [process.execPath, secondFile]);
    await wait(600);
    const second = BrowserWindow.getAllWindows().find(win => win.id !== window.id && win.id !== help.id);
    assert(second, 'Second document window missing');
    await waitForEditor(second);
    assert.equal(await second.webContents.executeJavaScript('document.querySelector("#btn-open").textContent'), 'Open');
    second.webContents.reload();
    await new Promise(resolve => second.webContents.once('did-finish-load', resolve));
    await waitForEditor(second);
    assert.equal(await second.webContents.executeJavaScript('document.documentElement.lang'), 'en-US');

    const cream = findMenuItem(Menu.getApplicationMenu().items, 'Cream White');
    assert(cream, 'Cream White menu item not found');
    cream.click(cream, window, {});
    await wait(450);

    const rendererTheme = await window.webContents.executeJavaScript(`(${(() => ({
      themeClass: document.body.className,
      hasCreamClass: document.body.classList.contains('theme-cream'),
      background: getComputedStyle(document.body).backgroundColor
    })).toString()})()`);
    assert.equal(rendererTheme.hasCreamClass, true, JSON.stringify(rendererTheme));
    assert.equal(rendererTheme.background, 'rgb(251, 247, 236)', JSON.stringify(rendererTheme));

    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8'));
    assert.equal(stored.menuLanguage, 'en-US');
    assert.equal(stored.theme, 'cream');
    const shots = path.join(__dirname, 'audit-shots');
    fs.mkdirSync(shots, { recursive: true });
    await window.webContents.executeJavaScript(`(() => {
      window.editor.eventEmitter.emit('closePopup');
      document.querySelector('#reading-settings').hidden = false;
      document.querySelector('#find-panel').classList.add('replace-mode');
    })()`);
    await wait(150);
    fs.writeFileSync(path.join(shots, 'language-english.png'), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(shots, 'language-help-english.png'), (await help.webContents.capturePage()).toPNG());

    const beforeChinese = await prepareEdit(window, 'markdown');
    const chinese = findMenuItem(Menu.getApplicationMenu().items, '中文');
    assert(chinese, 'Chinese menu item missing');
    chinese.click(chinese, window, {});
    await wait(350);
    const chineseState = await snapshot(window);
    assertPreserved(beforeChinese, chineseState);
    assert.equal(chineseState.language, 'zh-CN');
    assert.equal(chineseState.open, '打开');
    assert.equal(chineseState.find, '查找');
    assert.equal(chineseState.replace, '替换为');
    assert.equal(chineseState.bold, '加粗');
    await assertUndo(window);
    assert.equal(await help.webContents.executeJavaScript('document.title'), '关于 Markdown阅读器');
    assert.equal(await help.webContents.executeJavaScript('document.documentElement.lang'), 'zh-CN');
    assert.equal(await second.webContents.executeJavaScript('document.querySelector("#btn-open").textContent'), '打开');
    const restored = await waitForPreference('zh-CN');
    assert.equal(restored.menuLanguage, 'zh-CN');
    assert.equal(errors.length, 0, errors.join('\n'));

    clearTimeout(timeout);
    console.log('Full interface language, editor state/undo, dialogs, help and cream theme regression OK.');
    app.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  }
});
