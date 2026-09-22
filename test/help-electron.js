'use strict';

// 帮助窗口回归：页签切换、动态版本、主题同步、布局约束和开源链接外跳。

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packageJson = require('../package.json');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-help-')));
app.commandLine.appendSwitch('disable-gpu');

const openedUrls = [];
ipcMain.handle('help:getState', () => ({
  version: packageJson.version,
  themePreference: 'system',
  systemTheme: 'light'
}));
ipcMain.handle('shell:openExternal', (_event, url) => {
  openedUrls.push(url);
  return true;
});

const timeout = setTimeout(() => {
  console.error('Help test timed out');
  app.exit(1);
}, 30000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 920,
    height: 660,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: true
    }
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'help.html'));
  await wait(250);

  const initial = await win.webContents.executeJavaScript('window.helpApi.getState()');
  assert.equal(initial.activeSection, 'guide');
  assert.equal(initial.renderedTheme, 'light');
  assert.equal(documentTitle(await win.webContents.executeJavaScript('document.title')), 'Markdown阅读器帮助');

  const wideLayout = await win.webContents.executeJavaScript(`(${(() => ({
    viewport: document.documentElement.clientWidth,
    cards: [...document.querySelectorAll('.guide-card')].map((card) => ({
      width: card.getBoundingClientRect().width,
      left: card.getBoundingClientRect().left,
      right: card.getBoundingClientRect().right,
      top: card.getBoundingClientRect().top
    })),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  })).toString()})()`);
  assert.equal(wideLayout.cards.length, 6);
  assert.equal(wideLayout.horizontalOverflow, false);
  const lefts = wideLayout.cards.map((card) => card.left);
  const rights = wideLayout.cards.map((card) => card.right);
  assert(Math.max(...lefts) - Math.min(...lefts) <= 1, JSON.stringify(wideLayout.cards));
  assert(Math.max(...rights) - Math.min(...rights) <= 1, JSON.stringify(wideLayout.cards));
  assert(wideLayout.cards.every((card) => card.width > 500), JSON.stringify(wideLayout.cards));
  for (const card of wideLayout.cards) {
    assert(card.left >= 0 && card.right <= wideLayout.viewport, JSON.stringify(card));
  }
  for (let index = 1; index < wideLayout.cards.length; index += 1) {
    assert(wideLayout.cards[index].top > wideLayout.cards[index - 1].top, JSON.stringify(wideLayout.cards));
  }

  const guideScroll = await win.webContents.executeJavaScript(`(${(() => {
    const main = document.querySelector('.help-main');
    const maximum = main.scrollHeight - main.clientHeight;
    main.scrollTop = maximum;
    return {
      maximum,
      scrollTop: main.scrollTop,
      bodyScrollHeight: document.body.scrollHeight,
      bodyClientHeight: document.body.clientHeight
    };
  }).toString()})()`);
  assert(guideScroll.maximum > 0, JSON.stringify(guideScroll));
  assert(Math.abs(guideScroll.maximum - guideScroll.scrollTop) <= 1, JSON.stringify(guideScroll));
  assert(guideScroll.bodyScrollHeight <= guideScroll.bodyClientHeight, JSON.stringify(guideScroll));

  await win.webContents.executeJavaScript('document.querySelector(".help-main").scrollTop = 0');
  await wait(80);
  await win.webContents.sendInputEvent({
    type: 'mouseWheel',
    x: 620,
    y: 320,
    deltaY: -120
  });
  await wait(120);
  const wheelScroll = await win.webContents.executeJavaScript(`(${(() => ({
    scrollTop: document.querySelector('.help-main').scrollTop
  })).toString()})()`);
  assert(wheelScroll.scrollTop > 0, JSON.stringify(wheelScroll));
  await win.webContents.executeJavaScript('document.querySelector(".help-main").scrollTop = 0');
  await wait(80);
  fs.mkdirSync(path.join(__dirname, 'audit-shots'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, 'audit-shots', 'help-light-wide.png'),
    (await win.webContents.capturePage()).toPNG()
  );

  await win.webContents.executeJavaScript('window.helpApi.selectSection("about")');
  await wait(80);
  const about = await win.webContents.executeJavaScript(`(${(() => ({
    state: window.helpApi.getState(),
    aboutHidden: document.getElementById('about').hidden,
    guideHidden: document.getElementById('guide').hidden,
    version: document.getElementById('about-version').textContent,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  })).toString()})()`);
  assert.equal(about.aboutHidden, false);
  assert.equal(about.guideHidden, true);
  assert.equal(about.version, packageJson.version);
  assert.equal(about.state.activeSection, 'about');
  assert.equal(about.state.title, '关于 Markdown阅读器');
  assert.equal(about.overflow, false);

  const aboutScroll = await win.webContents.executeJavaScript(`(${(() => {
    const main = document.querySelector('.help-main');
    const maximum = main.scrollHeight - main.clientHeight;
    main.scrollTop = maximum;
    return { maximum, scrollTop: main.scrollTop };
  }).toString()})()`);
  assert(aboutScroll.maximum > 0, JSON.stringify(aboutScroll));
  assert(Math.abs(aboutScroll.maximum - aboutScroll.scrollTop) <= 1, JSON.stringify(aboutScroll));

  await win.webContents.executeJavaScript('document.querySelector(".help-main").scrollTop = 0');
  await wait(80);

  win.webContents.send('help:stateChanged', {
    version: packageJson.version,
    themePreference: 'dark',
    systemTheme: 'light'
  });
  await wait(100);
  const dark = await win.webContents.executeJavaScript('window.helpApi.getState()');
  assert.equal(dark.renderedTheme, 'dark');
  win.webContents.send('help:stateChanged', {
    version: packageJson.version,
    themePreference: 'cream',
    systemTheme: 'light'
  });
  await wait(350);
  const cream = await win.webContents.executeJavaScript(`(${(() => ({
    state: window.helpApi.getState(),
    hasClass: document.body.classList.contains('theme-cream'),
    background: getComputedStyle(document.body).backgroundColor
  })).toString()})()`);
  assert.equal(cream.state.renderedTheme, 'cream');
  assert.equal(cream.hasClass, true);
  assert.equal(cream.background, 'rgb(251, 247, 236)');
  fs.writeFileSync(
    path.join(__dirname, 'audit-shots', 'help-dark-about.png'),
    (await win.webContents.capturePage()).toPNG()
  );

  await win.webContents.executeJavaScript(`(${(() => {
    document.getElementById('open-source-link').click();
  }).toString()})()`);
  await wait(100);
  assert.deepEqual(openedUrls, ['https://github.com/YLZYZQ/markdown-reader/blob/main/THIRD_PARTY_NOTICES.md']);

  await win.webContents.executeJavaScript('window.helpApi.selectSection("guide")');
  await wait(80);
  win.setContentSize(730, 540);
  await wait(160);
  const compact = await win.webContents.executeJavaScript(`(${(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    firstCardWidth: document.querySelector('.guide-card').getBoundingClientRect().width,
    asideHeight: document.querySelector('.help-aside').getBoundingClientRect().height
  })).toString()})()`);
  assert.equal(compact.overflow, false);
  assert(compact.firstCardWidth > 220, JSON.stringify(compact));
  assert(compact.asideHeight < 80, JSON.stringify(compact));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'audit-shots', 'help-dark-compact.png'), image.toPNG());

  assert.deepEqual(errors, []);
  clearTimeout(timeout);
  console.log('Help page regression OK: sections, theme, compact layout, and provenance link.');
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});

function documentTitle(title) {
  return title;
}
