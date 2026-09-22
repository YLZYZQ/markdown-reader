'use strict';

// 主进程回归：菜单语言即时切换，主题菜单能把主编辑器切到奶油白并持久化。

const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-menu-language-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');

require('../main.js');

const timeout = setTimeout(() => {
  console.error('Menu language test timed out');
  app.exit(1);
}, 20000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

app.whenReady().then(async () => {
  try {
    await wait(900);
    assert(topLabels().includes('文件'), JSON.stringify(topLabels()));

    const menu = Menu.getApplicationMenu();
    const english = findMenuItem(menu.items, 'English');
    const window = BrowserWindow.getAllWindows()[0];
    assert(english, 'English menu item not found');
    english.click(english, window, {});
    await wait(120);
    assert(topLabels().includes('File'), JSON.stringify(topLabels()));
    assert(topLabels().includes('View'), JSON.stringify(topLabels()));

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

    clearTimeout(timeout);
    console.log('Menu language and cream theme regression OK.');
    app.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  }
});
