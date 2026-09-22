'use strict';

// 主进程：窗口、菜单、文件读写和未保存内容保护。
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const {
  getDocumentBaseUrl,
  getMarkdownImageUrl,
  normalizeFileSystemPath,
  normalizeDocumentPath,
  pathKey,
  sanitizeImageFileName
} = require('./lib/file-utils');
const { listDirectoryTree, listDocumentTree } = require('./lib/file-tree');
const { parseFileArg } = require('./lib/cli-args');
const { readDocumentContent } = require('./lib/doc-reader');
const { createDocumentWatcher } = require('./lib/doc-watcher');
const { resolveSaveChord } = require('./lib/save-chord');
const { loadPreferences, savePreferences, boundsIntersectDisplay } = require('./lib/preferences');
const { addRecentEntry, loadRecent, saveRecent } = require('./lib/recent');
const { clearSessionBackup, readSessionBackup, writeSessionBackup } = require('./lib/session-backup');
const { fetchLatestRelease, isNewerVersion } = require('./lib/update-checker');
const { formatMenuLabel, getMenuLabels, MENU_LANGUAGES } = require('./lib/menu-labels');
const appI18n = require('./lib/app-i18n');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const authorizedDocumentPaths = new Set();

const windowContexts = new Map();
let activeWindow = null;
let backupOwnerContextId = null;
let helpWindow = null;
let helpWindowWebContentsId = null;
let requestedHelpSection = 'guide';
let automaticUpdateCheckTimer = null;
let updateCheckInFlight = false;
const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const initialStartupDocumentPath = parseFileArg(process.argv);
let deferredOpenFilePath = null;

// 先确定数据目录，再读取语言、主题和最近文档；便携版不能读取安装版偏好。
const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR ||
  (fs.existsSync(path.join(path.dirname(process.execPath), 'portable-mode'))
    ? path.dirname(process.execPath)
    : null);
if (portableExecutableDir) {
  app.setPath('userData', path.join(portableExecutableDir, 'data'));
}

// 用户偏好（主题/窗口/缩放），userData/preferences.json 单一事实源。
const preferencesFilePath = () => path.join(app.getPath('userData'), 'preferences.json');
let preferences = loadPreferences(preferencesFilePath());
let preferencesSaveTimer = null;
let menuBuilt = false;

// 最近打开记录，userData/recent.json。
const recentFilePath = () => path.join(app.getPath('userData'), 'recent.json');
let recentEntries = loadRecent(recentFilePath());
let recentSaveTimer = null;

function recordRecentDocument(filePath) {
  try {
    recentEntries = addRecentEntry(recentEntries, filePath, Date.now());
    if (recentSaveTimer) clearTimeout(recentSaveTimer);
    recentSaveTimer = setTimeout(() => {
      recentSaveTimer = null;
      try {
        saveRecent(recentFilePath(), recentEntries);
      } catch (error) {
        console.warn('保存最近打开记录失败:', error);
      }
    }, 300);
  } catch (_) { /* 记录失败不影响打开文档 */ }
  if (menuBuilt) buildMenu();
}

function clearRecentDocuments() {
  recentEntries = [];
  try {
    saveRecent(recentFilePath(), recentEntries);
  } catch (_) { /* 忽略 */ }
  if (menuBuilt) buildMenu();
}

// 局部更新偏好并防抖写盘；主题变化时重建菜单以刷新勾选态。
function updatePreferences(patch) {
  preferences = { ...preferences, ...patch };
  if (preferencesSaveTimer) clearTimeout(preferencesSaveTimer);
  preferencesSaveTimer = setTimeout(() => {
    preferencesSaveTimer = null;
    try {
      savePreferences(preferencesFilePath(), preferences);
    } catch (error) {
      console.warn('保存偏好失败:', error);
    }
  }, 300);
  if (menuBuilt && ('theme' in patch || 'menuLanguage' in patch)) buildMenu();
  if ('menuLanguage' in patch) {
    for (const context of windowContexts.values()) {
      context.window?.webContents.send('editor:command', 'setLanguage', { language: preferences.menuLanguage });
    }
    sendHelpState();
  }
  if ('theme' in patch) sendHelpState();
}

function getWindowContext(event) {
  return windowContexts.get(event.sender.id) || null;
}

function isCurrentRenderer(event) {
  return Boolean(getWindowContext(event));
}

function isHelpRenderer(event) {
  return helpWindowWebContentsId !== null && event.sender.id === helpWindowWebContentsId;
}

function helpState() {
  return {
    version: app.getVersion(),
    themePreference: preferences.theme,
    systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    menuLanguage: preferences.menuLanguage
  };
}

function resolvedTheme() {
  if (preferences.theme !== 'system') return preferences.theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function themeBackgroundColor(theme) {
  if (theme === 'dark') return '#211f1b';
  if (theme === 'cream') return '#fbf7ec';
  return '#fffdf8';
}

function sendHelpState() {
  if (!helpWindow || helpWindow.isDestroyed()) return;
  helpWindow.webContents.send('help:stateChanged', helpState());
}

function showMessageBoxSafe(window, options) {
  return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

async function checkForUpdates({ automatic = false } = {}) {
  if (updateCheckInFlight) return;
  const t = getMenuLabels(preferences.menuLanguage);
  updateCheckInFlight = true;
  try {
    const latest = await fetchLatestRelease({ fetchImpl: net.fetch, timeoutMs: 8000 });
    updatePreferences({ lastUpdateCheckAt: Date.now() });

    if (!isNewerVersion(latest.version, app.getVersion())) {
      if (!automatic) {
        await showMessageBoxSafe(currentWindow(), {
          type: 'info',
          title: t.upToDateTitle,
          message: t.upToDateMessage,
          detail: `${t.currentVersion}：v${app.getVersion()}\n${t.latestVersion}：v${latest.version}`,
          buttons: ['OK'],
          defaultId: 0,
          noLink: true
        });
      }
      return;
    }

    const detailParts = [
      `${t.currentVersion}：v${app.getVersion()}`,
      `${t.latestVersion}：v${latest.version}`,
      '',
      t.updateActionHint
    ];
    if (latest.notes) detailParts.splice(2, 0, '', `${t.releaseNotes}：\n${latest.notes}`);

    const result = await showMessageBoxSafe(currentWindow(), {
      type: 'info',
      title: t.updateTitle,
      message: formatMenuLabel(t.updateMessage, { version: latest.version }),
      detail: detailParts.join('\n'),
      buttons: [t.viewRelease, t.later],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (result.response === 0) await openExternalUrl(latest.releasesUrl);
  } catch (error) {
    console.warn('检查更新失败:', error?.message || error);
    if (!automatic) {
      await showMessageBoxSafe(currentWindow(), {
        type: 'warning',
        title: t.checkFailedTitle,
        message: t.checkFailedMessage,
        detail: t.checkFailedDetail,
        buttons: ['OK'],
        defaultId: 0,
        noLink: true
      });
    }
  } finally {
    updateCheckInFlight = false;
  }
}

function scheduleAutomaticUpdateCheck() {
  if (automaticUpdateCheckTimer || !preferences.updateCheckEnabled) return;
  if (preferences.lastUpdateCheckAt + AUTOMATIC_UPDATE_CHECK_INTERVAL_MS > Date.now()) return;
  automaticUpdateCheckTimer = setTimeout(() => {
    automaticUpdateCheckTimer = null;
    void checkForUpdates({ automatic: true });
  }, 3000);
}

function currentWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && windowContexts.has(focused.webContents.id)) return focused;
  if (activeWindow && !activeWindow.isDestroyed()) return activeWindow;
  return [...windowContexts.values()][0]?.window || null;
}

function focusWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function findWindowByDocumentPath(filePath) {
  const target = pathKey(normalizeDocumentPath(filePath));
  for (const context of windowContexts.values()) {
    if (context.documentPath && pathKey(context.documentPath) === target) return context.window;
  }
  return null;
}

function openDocumentWindow(filePath) {
  if (!filePath) return;
  const existing = findWindowByDocumentPath(filePath);
  if (existing) {
    focusWindow(existing);
    return;
  }
  focusWindow(createWindow(filePath));
}

function hasDirtyWindow() {
  return [...windowContexts.values()].some((context) => context.dirty);
}

function errorResult(error) {
  if (error?.i18nKey) return { error: appI18n.t(preferences.menuLanguage, error.i18nKey, error.i18nValues) };
  return { error: error instanceof Error ? error.message : String(error) };
}

function authorizeDocument(filePath) {
  authorizedDocumentPaths.add(pathKey(filePath));
}

function assertAuthorizedDocument(filePath) {
  const normalized = normalizeDocumentPath(filePath);
  if (!authorizedDocumentPaths.has(pathKey(normalized))) {
    throw new Error(appI18n.t(preferences.menuLanguage, 'errors.unauthorizedDocument'));
  }
  return normalized;
}

function assertAuthorizedTreePath(filePath, context) {
  const normalized = normalizeFileSystemPath(filePath);
  const normalizedKey = pathKey(normalized);
  const rootKey = context.documentPath ? path.dirname(pathKey(context.documentPath)) : null;
  if (rootKey && (normalizedKey === rootKey || normalizedKey.startsWith(`${rootKey}${path.sep}`))) {
    return normalized;
  }
  throw new Error(appI18n.t(preferences.menuLanguage, 'errors.unauthorizedDirectory'));
}

async function readDocument(filePath, context = null) {
  const normalized = normalizeDocumentPath(filePath);
  const { content } = await readDocumentContent(normalized);
  authorizeDocument(normalized);
  if (context) {
    context.documentPath = normalized;
    context.watcher.watch(normalized);
  }
  recordRecentDocument(normalized);
  return {
    canceled: false,
    filePath: normalized,
    content,
    baseUrl: getDocumentBaseUrl(normalized)
  };
}

async function getUniqueImagePath(imageDir, fileName) {
  const parsed = path.parse(fileName);
  for (let index = 0; ; index += 1) {
    const candidateName = index === 0 ? fileName : `${parsed.name}-${index}${parsed.ext}`;
    const candidatePath = path.join(imageDir, candidateName);
    try {
      await fsp.access(candidatePath, fs.constants.F_OK);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { candidateName, candidatePath };
      throw error;
    }
  }
}

async function saveImageBuffer(mdFilePath, fileName, arrayBuffer) {
  const documentPath = assertAuthorizedDocument(mdFilePath);
  const safeName = sanitizeImageFileName(fileName);
  if (!(arrayBuffer instanceof ArrayBuffer)) throw new TypeError(appI18n.t(preferences.menuLanguage, 'errors.invalidImage'));
  if (arrayBuffer.byteLength === 0) throw new TypeError(appI18n.t(preferences.menuLanguage, 'errors.emptyImage'));
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) throw new TypeError(appI18n.t(preferences.menuLanguage, 'errors.imageTooLarge'));

  const imageDir = path.join(path.dirname(documentPath), 'images');
  await fsp.mkdir(imageDir, { recursive: true });

  // 使用独占写入处理并发插入时的同名竞争。
  let nextName = safeName;
  let destination;
  while (true) {
    ({ candidateName: nextName, candidatePath: destination } = await getUniqueImagePath(imageDir, nextName));
    try {
      await fsp.writeFile(destination, Buffer.from(arrayBuffer), { flag: 'wx' });
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const parsed = path.parse(nextName);
      nextName = `${parsed.name}-1${parsed.ext}`;
    }
  }

  return {
    markdownUrl: getMarkdownImageUrl(nextName),
    alt: path.basename(nextName, path.extname(nextName))
  };
}

async function openExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      await shell.openExternal(parsed.href);
      return true;
    }
  } catch (_) {
    // 忽略无效或不受支持的链接。
  }
  return false;
}

async function promptForClose(context) {
  const window = context.window;
  if (!window || window.isDestroyed() || context.closePromptOpen) return;
  context.closePromptOpen = true;
  const u = appI18n.getDictionary(preferences.menuLanguage);
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: u.dialogs.saveChanges,
      message: u.dialogs.unsavedMessage,
      detail: u.dialogs.closeDetail,
      buttons: [u.dialogs.save, u.dialogs.dontSave, u.dialogs.cancel],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });

    if (!window || window.isDestroyed()) return;
    if (result.response === 0) {
      window.webContents.send('document:saveBeforeClose');
    } else if (result.response === 1) {
      context.dirty = false;
      if (!hasDirtyWindow()) clearSessionBackup(app.getPath('userData'));
      context.allowClose = true;
      window.close();
    }
  } finally {
    context.closePromptOpen = false;
  }
}

function createWindow(startupDocumentPath = null) {
  const context = {
    id: null,
    window: null,
    dirty: false,
    allowClose: false,
    closePromptOpen: false,
    rendererReady: false,
    documentPath: startupDocumentPath,
    startupDocumentPath,
    watcher: null
  };
  context.watcher = createDocumentWatcher({
    onExternalChange: () => {
      if (!context.window || context.window.isDestroyed()) return;
      context.window.webContents.send('file:externalChanged', 'modified');
    }
  });

  // 首个窗口恢复上次位置；后续文件关联窗口在它旁边级联，保证两个文件夹可见。
  const savedBounds = boundsIntersectDisplay(
    preferences.windowBounds,
    screen.getAllDisplays().map((display) => display.workArea),
  ) ? preferences.windowBounds : null;
  const existingWindows = [...windowContexts.values()].map((item) => item.window);
  const referenceWindow = activeWindow && !activeWindow.isDestroyed() ? activeWindow : existingWindows[0];
  const referenceBounds = referenceWindow ? referenceWindow.getNormalBounds() : null;
  const workArea = referenceWindow
    ? screen.getDisplayMatching(referenceWindow.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea;
  const width = savedBounds?.width || referenceBounds?.width || 1200;
  const height = savedBounds?.height || referenceBounds?.height || 800;
  let x = savedBounds?.x ?? referenceBounds?.x ?? workArea.x;
  let y = savedBounds?.y ?? referenceBounds?.y ?? workArea.y;
  if (existingWindows.length) {
    const cascade = (existingWindows.length % 6 || 1) * 36;
    x += cascade;
    y += cascade;
    if (x + width > workArea.x + workArea.width || y + height > workArea.y + workArea.height) {
      x = workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2));
      y = workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2));
    }
  }

  const window = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 500,
    x,
    y,
    backgroundColor: themeBackgroundColor(resolvedTheme()),
    show: false,
    title: `${appI18n.t(preferences.menuLanguage, 'untitled')} - ${preferences.menuLanguage === 'en-US' ? 'Markdown Reader' : 'Markdown阅读器'}`,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  context.window = window;
  context.id = window.webContents.id;
  windowContexts.set(context.id, context);
  if (backupOwnerContextId === null) backupOwnerContextId = context.id;
  if (!existingWindows.length && savedBounds?.maximized) window.maximize();
  void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const sendZoomLevel = () => {
    if (window.isDestroyed()) return;
    window.webContents.send('zoom:levelChanged', window.webContents.getZoomLevel());
  };
  window.webContents.on('zoom-changed', () => {
    if (!window.isDestroyed()) updatePreferences({ zoomLevel: window.webContents.getZoomLevel() });
    sendZoomLevel();
  });
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed() && preferences.zoomLevel) window.webContents.setZoomLevel(preferences.zoomLevel);
    sendZoomLevel();
  });

  // Toast UI 的 Ctrl+S/Ctrl+Shift+S 绑定会抢占菜单加速键，这里提前转发。
  window.webContents.on('before-input-event', (event, input) => {
    const chord = resolveSaveChord(input);
    if (!chord) return;
    event.preventDefault();
    window.webContents.send(chord === 'saveAs' ? 'menu:saveAs' : 'menu:save');
  });

  window.on('focus', () => {
    activeWindow = window;
  });
  window.once('ready-to-show', () => {
    activeWindow = window;
    window.show();
  });
  window.on('close', (event) => {
    if (!window.isDestroyed() && !window.isMinimized()) {
      const bounds = window.getNormalBounds();
      if (boundsIntersectDisplay(bounds, screen.getAllDisplays().map((display) => display.workArea))) {
        updatePreferences({ windowBounds: { ...bounds, maximized: window.isMaximized() } });
      }
    }
    if (!context.dirty && !hasDirtyWindow()) clearSessionBackup(app.getPath('userData'));
    if (context.allowClose || !context.dirty) return;
    event.preventDefault();
    void promptForClose(context);
  });
  window.on('closed', () => {
    windowContexts.delete(context.id);
    context.watcher.stop();
    if (activeWindow === window) activeWindow = null;
    if (backupOwnerContextId === context.id) {
      backupOwnerContextId = [...windowContexts.keys()][0] || null;
    }
  });

  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    void openExternalUrl(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });
  return window;
}

ipcMain.handle('file:open', async (event) => {
  const context = getWindowContext(event);
  const u = appI18n.getDictionary(preferences.menuLanguage);
  if (!context) return errorResult(u.errors.invalidSource);
  const result = await dialog.showOpenDialog(context.window, {
    title: u.dialogs.openFile,
    filters: [
      { name: u.dialogs.markdown, extensions: ['md', 'markdown', 'mdown', 'txt'] },
      { name: u.dialogs.allFiles, extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const existingWindow = findWindowByDocumentPath(result.filePaths[0]);
  if (existingWindow && existingWindow !== context.window) {
    focusWindow(existingWindow);
    return { canceled: true };
  }
  try {
    return await readDocument(result.filePaths[0], context);
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('file:openPath', async (event, filePath) => {
  const context = getWindowContext(event);
  if (!context) return errorResult(appI18n.getDictionary(preferences.menuLanguage).errors.invalidSource);
  const existingWindow = findWindowByDocumentPath(filePath);
  if (existingWindow && existingWindow !== context.window) {
    focusWindow(existingWindow);
    return { canceled: true };
  }
  try {
    return await readDocument(filePath, context);
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('startup:takeDocument', async (event) => {
  const context = getWindowContext(event);
  if (!context) return errorResult(appI18n.getDictionary(preferences.menuLanguage).errors.invalidSource);
  const filePath = context.startupDocumentPath;
  context.startupDocumentPath = null;
  context.documentPath = null;
  if (!filePath) return { canceled: true };
  try {
    return await readDocument(filePath, context);
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.on('app:rendererReady', (event) => {
  const context = getWindowContext(event);
  if (context) context.rendererReady = true;
});

ipcMain.handle('directory:listForDocument', async (event, filePath) => {
  const context = getWindowContext(event);
  if (!context) return errorResult(appI18n.getDictionary(preferences.menuLanguage).errors.invalidSource);
  try {
    const treePath = assertAuthorizedTreePath(filePath, context);
    const stats = await fsp.stat(treePath);
    return stats.isDirectory() ? listDirectoryTree(treePath) : listDocumentTree(treePath);
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('file:save', async (event, filePath, content) => {
  const context = getWindowContext(event);
  const u = appI18n.getDictionary(preferences.menuLanguage);
  if (!context) return errorResult(u.errors.invalidSource);
  if (typeof content !== 'string') return errorResult(u.errors.invalidContent);

  let targetPath;
  try {
    if (filePath) {
      targetPath = assertAuthorizedDocument(filePath);
    } else {
      const result = await dialog.showSaveDialog(context.window, {
        title: u.dialogs.saveFile,
        defaultPath: appI18n.t(preferences.menuLanguage, 'untitled'),
        filters: [
          { name: u.dialogs.markdown, extensions: ['md'] },
          { name: u.dialogs.text, extensions: ['txt'] }
        ]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      targetPath = normalizeDocumentPath(result.filePath);
    }

    await fsp.writeFile(targetPath, content, 'utf8');
    authorizeDocument(targetPath);
    context.documentPath = targetPath;
    await context.watcher.markOwnWrite(targetPath);
    context.watcher.watch(targetPath);
    recordRecentDocument(targetPath);
    return {
      canceled: false,
      filePath: targetPath,
      baseUrl: getDocumentBaseUrl(targetPath)
    };
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('document:confirmReplace', async (event) => {
  const context = getWindowContext(event);
  if (!context) return 'cancel';
  const u = appI18n.getDictionary(preferences.menuLanguage);
  const result = await dialog.showMessageBox(context.window, {
    type: 'warning',
    title: u.dialogs.saveChanges,
    message: u.dialogs.unsavedMessage,
    detail: u.dialogs.replaceDetail,
    buttons: [u.dialogs.save, u.dialogs.dontSave, u.dialogs.cancel],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  return ['save', 'discard', 'cancel'][result.response] || 'cancel';
});

ipcMain.on('document:setDirty', (event, dirty) => {
  const context = getWindowContext(event);
  if (context) context.dirty = Boolean(dirty);
});

ipcMain.on('document:stopWatching', (event) => {
  const context = getWindowContext(event);
  if (context) {
    context.documentPath = null;
    context.watcher.stop();
  }
});

// 偏好：渲染进程启动读取一次；局部补丁由主进程防抖落盘。
ipcMain.handle('prefs:getAll', (event) => {
  if (!isCurrentRenderer(event)) return { ...require('./lib/preferences').DEFAULT_PREFERENCES };
  return { ...preferences };
});

ipcMain.on('prefs:set', (event, patch) => {
  if (!isCurrentRenderer(event) || !patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  updatePreferences(patch);
});

// ============ 崩溃恢复备份与最近打开 ============
ipcMain.on('backup:write', (event, session) => {
  const context = getWindowContext(event);
  if (!context || context.id !== backupOwnerContextId) return;
  try {
    writeSessionBackup(app.getPath('userData'), session);
  } catch (error) {
    console.warn('写入崩溃恢复备份失败:', error);
  }
});

ipcMain.on('backup:clear', (event) => {
  const context = getWindowContext(event);
  if (context && context.id === backupOwnerContextId) clearSessionBackup(app.getPath('userData'));
});

// 读取并立即清除备份（恢复与否由用户决定，读取后不再保留）。
ipcMain.handle('backup:take', (event) => {
  const context = getWindowContext(event);
  if (!context || context.id !== backupOwnerContextId) return null;
  try {
    return readSessionBackup(app.getPath('userData'));
  } finally {
    clearSessionBackup(app.getPath('userData'));
  }
});

ipcMain.handle('backup:confirmRestore', async (event, info) => {
  const context = getWindowContext(event);
  if (!context || context.window?.isDestroyed()) return 'discard';
  const u = appI18n.getDictionary(preferences.menuLanguage);
  const detailParts = [];
  if (info && Number.isFinite(info.savedAt) && info.savedAt > 0) {
    detailParts.push(appI18n.format(u.dialogs.lastModified, {
      time: new Date(info.savedAt).toLocaleString(preferences.menuLanguage)
    }));
  }
  detailParts.push(info && info.filePath
    ? appI18n.format(u.dialogs.document, { path: info.filePath })
    : u.dialogs.untitledDocument);
  const result = await dialog.showMessageBox(context.window, {
    type: 'warning',
    title: u.dialogs.restoreTitle,
    message: u.dialogs.restoreMessage,
    detail: detailParts.join('\n') + '\n\n' + u.dialogs.restorePrompt,
    buttons: [u.dialogs.restore, u.dialogs.discard],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  return result.response === 0 ? 'restore' : 'discard';
});

ipcMain.handle('recent:get', (event) => {
  if (!isCurrentRenderer(event)) return [];
  return recentEntries.map((entry) => ({ ...entry }));
});

// ============ 打印与导出 ============
// 独立隐藏窗口统一渲染：白底、等 Mermaid 渲染完成，PDF/HTML/打印共用一条管线。
let printWindow = null;

async function runPrintPipeline(markdown, action) {
  if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
  printWindow = new BrowserWindow({
    width: 794,
    height: 1123,
    useContentSize: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  try {
    await printWindow.loadFile(path.join(__dirname, 'renderer', 'print.html'));
    await printWindow.webContents.executeJavaScript(`window.setPrintContent(${JSON.stringify(String(markdown || ''))})`);
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await printWindow.webContents.executeJavaScript('window.__printReady === true');
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error(appI18n.t(preferences.menuLanguage, 'errors.printTimeout'));

    if (action === 'pdf') {
      const pdfBuffer = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      return { action: 'pdf', buffer: pdfBuffer };
    }
    if (action === 'html') {
      const body = await printWindow.webContents.executeJavaScript('window.buildExportHtmlBody()');
      return { action: 'html', body };
    }
    if (action === 'print') {
      const printResult = await new Promise((resolve, reject) => {
        printWindow.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
          if (success || failureReason === 'cancelled') resolve({ canceled: failureReason === 'cancelled' });
          else reject(new Error(failureReason || appI18n.t(preferences.menuLanguage, 'errors.printFailed')));
        });
      });
      return { action: 'print', canceled: Boolean(printResult.canceled) };
    }
    throw new Error(appI18n.t(preferences.menuLanguage, 'errors.unknownPrintAction'));
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
    printWindow = null;
  }
}

function buildExportHtmlDocument(filePath, body) {
  const cssFiles = [
    path.join(__dirname, 'renderer', 'tui-editor', 'toastui-editor.css'),
    path.join(__dirname, 'renderer', 'tui-editor', 'toastui-editor-plugin-code-syntax-highlight.css'),
    path.join(__dirname, 'renderer', 'tui-editor', 'prism.css'),
    path.join(__dirname, 'renderer', 'print.css'),
  ];
  const css = cssFiles.map((file) => {
    try {
      return `/* ${path.basename(file)} */\n${fs.readFileSync(file, 'utf8')}`;
    } catch (_) {
      return '';
    }
  }).join('\n');
  const title = path.basename(filePath).replace(/\.html$/i, '');
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body class="export-html">',
    '<div class="export-body">',
    body,
    '</div>',
    '</body>',
    '</html>'
  ].join('\n');
}

ipcMain.handle('print:document', async (event, markdown) => {
  const u = appI18n.getDictionary(preferences.menuLanguage);
  if (!isCurrentRenderer(event)) return errorResult(u.errors.invalidSource);
  if (typeof markdown !== 'string') return errorResult(u.errors.invalidContent);
  try {
    const result = await runPrintPipeline(markdown, 'print');
    return { canceled: Boolean(result.canceled) };
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('export:document', async (event, format, markdown, suggestedPath) => {
  const context = getWindowContext(event);
  const u = appI18n.getDictionary(preferences.menuLanguage);
  if (!context) return errorResult(u.errors.invalidSource);
  if (typeof markdown !== 'string') return errorResult(u.errors.invalidContent);
  if (format !== 'pdf' && format !== 'html') return errorResult(u.errors.unsupportedFormat);
  try {
    const defaultPath = typeof suggestedPath === 'string' && suggestedPath.trim()
      ? suggestedPath.trim()
      : `${appI18n.t(preferences.menuLanguage, 'untitled').replace(/\.(md|txt)$/, '')}.${format}`;
    const dialogResult = await dialog.showSaveDialog(context.window, {
      title: format === 'pdf' ? u.dialogs.exportPdf : u.dialogs.exportHtml,
      defaultPath,
      filters: format === 'pdf'
        ? [{ name: u.dialogs.pdfDocument, extensions: ['pdf'] }]
        : [{ name: u.dialogs.htmlDocument, extensions: ['html'] }]
    });
    if (dialogResult.canceled || !dialogResult.filePath) return { canceled: true };
    const targetPath = path.resolve(dialogResult.filePath);

    const result = await runPrintPipeline(markdown, format);
    if (result.action === 'pdf') {
      await fsp.writeFile(targetPath, result.buffer);
    } else {
      await fsp.writeFile(targetPath, buildExportHtmlDocument(targetPath, result.body), 'utf8');
    }
    if (context.window && !context.window.isDestroyed()) shell.showItemInFolder(targetPath);
    return { canceled: false, filePath: targetPath };
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.on('window:closeAfterSave', (event) => {
  const context = getWindowContext(event);
  if (!context?.window) return;
  context.dirty = false;
  context.allowClose = true;
  context.window.close();
});

ipcMain.handle('theme:getSystem', (event) => {
  if (!isCurrentRenderer(event)) return 'light';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

ipcMain.handle('help:getState', (event) => {
  if (!isHelpRenderer(event)) return null;
  return helpState();
});

ipcMain.handle('shell:openExternal', async (event, url) => {
  if ((!isCurrentRenderer(event) && !isHelpRenderer(event)) || typeof url !== 'string') return false;
  return openExternalUrl(url);
});

ipcMain.handle('image:saveBlob', async (event, mdFilePath, fileName, arrayBuffer) => {
  if (!isCurrentRenderer(event)) return errorResult(appI18n.getDictionary(preferences.menuLanguage).errors.invalidSource);
  try {
    return await saveImageBuffer(mdFilePath, fileName, arrayBuffer);
  } catch (error) {
    return errorResult(error);
  }
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const t = getMenuLabels(preferences.menuLanguage);
  const sendCommand = (name, payload) => {
    currentWindow()?.webContents.send('editor:command', name, payload);
  };
  const changeZoom = (delta) => {
    const window = currentWindow();
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    const next = delta === null ? 0 : contents.getZoomLevel() + delta;
    contents.setZoomLevel(next);
    updatePreferences({ zoomLevel: contents.getZoomLevel() });
    contents.send('zoom:levelChanged', contents.getZoomLevel());
  };
  const sendCommandOrStartWindow = (name) => {
    const window = currentWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(`menu:${name}`);
      return;
    }
    const created = createWindow();
    created.webContents.once('did-finish-load', () => {
      if (!created.isDestroyed()) created.webContents.send(`menu:${name}`);
    });
  };
  const setThemePreference = (theme) => {
    updatePreferences({ theme });
    for (const context of windowContexts.values()) {
      if (theme === 'system') context.window?.webContents.send('editor:command', 'followSystemTheme');
      else context.window?.webContents.send('editor:command', 'setTheme', { theme });
    }
  };
  const cycleTheme = () => {
    const current = preferences.theme === 'system'
      ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
      : preferences.theme;
    setThemePreference(current === 'light' ? 'cream' : current === 'cream' ? 'dark' : 'light');
  };
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: t.file,
      submenu: [
        { label: t.new, accelerator: 'CmdOrCtrl+N', click: () => sendCommandOrStartWindow('new') },
        { label: t.newWindow, accelerator: 'CmdOrCtrl+Shift+N', click: () => focusWindow(createWindow()) },
        { label: t.open, accelerator: 'CmdOrCtrl+O', click: () => sendCommandOrStartWindow('open') },
        // Ctrl+S 实际由 before-input-event 拦截转发；这里只显示快捷键（registerAccelerator: false）。
        { label: t.save, accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => currentWindow()?.webContents.send('menu:save') },
        { label: t.saveAs, accelerator: 'CmdOrCtrl+Shift+S', click: () => currentWindow()?.webContents.send('menu:saveAs') },
        { type: 'separator' },
        { label: t.print, accelerator: 'CmdOrCtrl+P', click: () => sendCommand('print') },
        {
          label: t.export,
          submenu: [
            { label: t.pdf, click: () => sendCommand('export', { format: 'pdf' }) },
            { label: t.html, click: () => sendCommand('export', { format: 'html' }) },
          ]
        },
        { type: 'separator' },
        {
          label: t.recent,
          submenu: recentEntries.length ? [
            ...recentEntries.map((entry) => ({
              label: path.basename(entry.path),
              click: () => {
                openDocumentWindow(entry.path);
              }
            })),
            { type: 'separator' },
            { label: t.clearRecent, click: clearRecentDocuments },
          ] : [{ label: t.noRecent, enabled: false }]
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: t.close } : { role: 'quit', label: t.quit }
      ]
    },
    {
      label: t.edit,
      submenu: [
        { label: t.undo, accelerator: 'CmdOrCtrl+Z', click: () => sendCommand('undo') },
        { label: t.redo, accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendCommand('redo') },
        { type: 'separator' },
        { role: 'cut', label: t.cut },
        { role: 'copy', label: t.copy },
        { role: 'paste', label: t.paste },
        { label: t.selectAll, accelerator: 'CmdOrCtrl+A', click: () => sendCommand('selectAll') },
        { type: 'separator' },
        { label: t.find, accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') },
        { label: t.findNext, accelerator: 'F3', click: () => sendCommand('findNext') },
        { label: t.findPrevious, accelerator: 'Shift+F3', click: () => sendCommand('findPrevious') },
        { label: t.replace, accelerator: 'CmdOrCtrl+H', click: () => sendCommand('replace') }
      ]
    },
    {
      label: t.paragraph,
      submenu: [
        { label: t.text, accelerator: 'CmdOrCtrl+0', click: () => sendCommand('heading', { level: 0 }) },
        ...Array.from({ length: 6 }, (_, index) => ({
          label: `${index + 1}${t.headingLevel}`,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: () => sendCommand('heading', { level: index + 1 })
        })),
        { type: 'separator' },
        { label: t.blockQuote, click: () => sendCommand('blockQuote') },
        { label: t.bulletList, click: () => sendCommand('bulletList') },
        { label: t.orderedList, click: () => sendCommand('orderedList') },
        { label: t.taskList, click: () => sendCommand('taskList') },
        { label: t.codeBlock, accelerator: 'CmdOrCtrl+Shift+K', click: () => sendCommand('codeBlock') }
      ]
    },
    {
      label: t.format,
      submenu: [
        { label: t.bold, accelerator: 'CmdOrCtrl+B', click: () => sendCommand('bold') },
        { label: t.italic, accelerator: 'CmdOrCtrl+I', click: () => sendCommand('italic') },
        { label: t.strike, click: () => sendCommand('strike') },
        { label: t.inlineCode, click: () => sendCommand('code') },
        { type: 'separator' },
        { label: t.insertLink, accelerator: 'CmdOrCtrl+K', click: () => sendCommand('popup', { name: 'link' }) }
      ]
    },
    {
      label: t.insert,
      submenu: [
        { label: t.image, click: () => sendCommand('popup', { name: 'image' }) },
        { label: t.link, click: () => sendCommand('popup', { name: 'link' }) },
        { label: t.table, click: () => sendCommand('popup', { name: 'table' }) },
        { label: t.codeBlock, click: () => sendCommand('codeBlock') },
        { label: t.horizontalRule, click: () => sendCommand('hr') },
        { label: t.dateTime, click: () => sendCommand('dateTime') }
      ]
    },
    {
      label: t.view,
      submenu: [
        { label: t.sidebar, accelerator: 'CmdOrCtrl+Shift+E', click: () => sendCommand('toggleSidebar') },
        { label: t.outline, accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('showOutline') },
        { label: t.focus, accelerator: 'F8', click: () => sendCommand('toggleFocus') },
        { type: 'separator' },
        { label: t.toggleMode, accelerator: 'CmdOrCtrl+/', click: () => sendCommand('toggleMode') },
        { type: 'separator' },
        { label: t.cycleTheme, accelerator: 'CmdOrCtrl+Shift+T', click: cycleTheme },
        {
          label: t.theme,
          submenu: [
            { label: t.followSystem, type: 'radio', checked: preferences.theme === 'system', click: () => setThemePreference('system') },
            { label: t.light, type: 'radio', checked: preferences.theme === 'light', click: () => setThemePreference('light') },
            { label: t.cream, type: 'radio', checked: preferences.theme === 'cream', click: () => setThemePreference('cream') },
            { label: t.dark, type: 'radio', checked: preferences.theme === 'dark', click: () => setThemePreference('dark') },
          ]
        },
        {
          label: t.language,
          submenu: MENU_LANGUAGES.map((language) => ({
            label: language === 'zh-CN' ? getMenuLabels(language).chinese : getMenuLabels(language).english,
            type: 'radio',
            checked: preferences.menuLanguage === language,
            click: () => updatePreferences({ menuLanguage: language })
          })),
        },
        {
          label: t.autoSave,
          type: 'checkbox',
          checked: preferences.autoSave === true,
          click: () => {
            const next = !(preferences.autoSave === true);
            updatePreferences({ autoSave: next });
            sendCommand('autoSaveChanged', { enabled: next });
          }
        },
        { type: 'separator' },
        {
          label: t.fontSize,
          submenu: [14, 16, 18, 20, 22, 24].map((size) => ({
            label: `${size} px`,
            type: 'radio',
            checked: (preferences.editorFontSize || 16) === size,
            click: () => {
              updatePreferences({ editorFontSize: size });
              sendCommand('setFontSize', { size });
            }
          })),
        },
        {
          label: t.editorFont,
          submenu: [
            { label: t.followTheme, type: 'radio', checked: !preferences.editorFontFamily, click: () => { updatePreferences({ editorFontFamily: '' }); sendCommand('setFontFamily', { family: '' }); } },
            { label: t.sans, type: 'radio', checked: preferences.editorFontFamily === 'sans', click: () => { updatePreferences({ editorFontFamily: 'sans' }); sendCommand('setFontFamily', { family: 'sans' }); } },
            { label: t.serif, type: 'radio', checked: preferences.editorFontFamily === 'serif', click: () => { updatePreferences({ editorFontFamily: 'serif' }); sendCommand('setFontFamily', { family: 'serif' }); } },
            { label: t.mono, type: 'radio', checked: preferences.editorFontFamily === 'mono', click: () => { updatePreferences({ editorFontFamily: 'mono' }); sendCommand('setFontFamily', { family: 'mono' }); } },
          ],
        },
        { type: 'separator' },
        { label: t.zoomIn, accelerator: 'CmdOrCtrl+=', click: () => changeZoom(0.5) },
        { label: t.zoomOut, accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.5) },
        { label: t.resetZoom, accelerator: 'CmdOrCtrl+0', click: () => changeZoom(null) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.fullscreen }
      ]
    },
    {
      label: t.help,
      submenu: [
        { label: t.checkUpdates, click: () => void checkForUpdates() },
        {
          label: t.automaticUpdateCheck,
          type: 'checkbox',
          checked: preferences.updateCheckEnabled,
          click: () => {
            const enabled = !preferences.updateCheckEnabled;
            updatePreferences({ updateCheckEnabled: enabled });
            if (enabled) {
              scheduleAutomaticUpdateCheck();
            } else if (automaticUpdateCheckTimer) {
              clearTimeout(automaticUpdateCheckTimer);
              automaticUpdateCheckTimer = null;
            }
          }
        },
        {
          label: t.guide,
          click: () => showHelpWindow('guide')
        },
        { type: 'separator' },
        {
          label: t.about,
          click: () => showHelpWindow('about')
        }
      ]
    }
  ];
  menuBuilt = true;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showHelpWindow(section = 'guide') {
  requestedHelpSection = section;
  if (helpWindow && !helpWindow.isDestroyed()) {
    focusWindow(helpWindow);
    helpWindow.webContents.send('help:showSection', { section });
    sendHelpState();
    return helpWindow;
  }

  const theme = resolvedTheme();
  helpWindow = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: themeBackgroundColor(theme),
    show: false,
    title: appI18n.t(preferences.menuLanguage, 'helpTitle'),
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  helpWindowWebContentsId = helpWindow.webContents.id;
  helpWindow.removeMenu();

  helpWindow.webContents.on('did-finish-load', () => {
    sendHelpState();
    helpWindow.webContents.send('help:showSection', { section: requestedHelpSection });
  });
  helpWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    void openExternalUrl(url);
  });
  helpWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });
  helpWindow.once('ready-to-show', () => helpWindow.show());
  helpWindow.on('closed', () => {
    helpWindow = null;
    helpWindowWebContentsId = null;
  });
  void helpWindow.loadFile(path.join(__dirname, 'renderer', 'help.html'));
  return helpWindow;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = parseFileArg(argv);
    if (filePath) {
      openDocumentWindow(filePath);
      return;
    }
    if (windowContexts.size === 0) createWindow();
    focusWindow(currentWindow());
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!app.isReady()) {
      deferredOpenFilePath = filePath;
      return;
    }
    openDocumentWindow(filePath);
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.local.mdreader');
    createWindow(deferredOpenFilePath || initialStartupDocumentPath);
    deferredOpenFilePath = null;
    buildMenu();
    scheduleAutomaticUpdateCheck();

    nativeTheme.on('updated', () => {
      const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      for (const context of windowContexts.values()) {
        context.window?.webContents.send('theme:systemChanged', theme);
      }
      sendHelpState();
    });

    app.on('activate', () => {
      if (windowContexts.size === 0) createWindow();
    });

    app.on('will-quit', () => {
      if (automaticUpdateCheckTimer) {
        clearTimeout(automaticUpdateCheckTimer);
        automaticUpdateCheckTimer = null;
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
