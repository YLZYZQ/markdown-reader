'use strict';

// 主进程：窗口、菜单、文件读写和未保存内容保护。
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell, screen } = require('electron');
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

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const authorizedDocumentPaths = new Set();

const windowContexts = new Map();
let activeWindow = null;
let backupOwnerContextId = null;
const initialStartupDocumentPath = parseFileArg(process.argv);
let deferredOpenFilePath = null;

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
  if (menuBuilt && 'theme' in patch) buildMenu();
}

const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR ||
  (fs.existsSync(path.join(path.dirname(process.execPath), 'portable-mode'))
    ? path.dirname(process.execPath)
    : null);

if (portableExecutableDir) {
  app.setPath('userData', path.join(portableExecutableDir, 'data'));
}

function getWindowContext(event) {
  return windowContexts.get(event.sender.id) || null;
}

function isCurrentRenderer(event) {
  return Boolean(getWindowContext(event));
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
  return { error: error instanceof Error ? error.message : String(error) };
}

function authorizeDocument(filePath) {
  authorizedDocumentPaths.add(pathKey(filePath));
}

function assertAuthorizedDocument(filePath) {
  const normalized = normalizeDocumentPath(filePath);
  if (!authorizedDocumentPaths.has(pathKey(normalized))) {
    throw new Error('未授权的文档路径');
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
  throw new Error('未授权的目录路径');
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
  if (!(arrayBuffer instanceof ArrayBuffer)) throw new TypeError('图片数据无效');
  if (arrayBuffer.byteLength === 0) throw new TypeError('图片数据为空');
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) throw new TypeError('图片不能超过 25 MB');

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
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: '保存更改',
      message: '当前文档有尚未保存的更改。',
      detail: '关闭窗口前是否保存？',
      buttons: ['保存', '不保存', '取消'],
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
    backgroundColor: '#ffffff',
    show: false,
    title: '未命名.md - Markdown阅读器',
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

ipcMain.handle('shell:openExternal', async (event, url) => {
  if (!isCurrentRenderer(event) || typeof url !== 'string') return false;
  return openExternalUrl(url);
});

ipcMain.handle('file:open', async (event) => {
  const context = getWindowContext(event);
  if (!context) return errorResult('无效的调用来源');
  const result = await dialog.showOpenDialog(context.window, {
    title: '打开 Markdown 文件',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
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
  if (!context) return errorResult('无效的调用来源');
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
  if (!context) return errorResult('无效的调用来源');
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
  if (!context) return errorResult('无效的调用来源');
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
  if (!context) return errorResult('无效的调用来源');
  if (typeof content !== 'string') return errorResult('文档内容无效');

  let targetPath;
  try {
    if (filePath) {
      targetPath = assertAuthorizedDocument(filePath);
    } else {
      const result = await dialog.showSaveDialog(context.window, {
        title: '保存 Markdown 文件',
        defaultPath: '未命名.md',
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: '文本', extensions: ['txt'] }
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
  const result = await dialog.showMessageBox(context.window, {
    type: 'warning',
    title: '保存更改',
    message: '当前文档有尚未保存的更改。',
    detail: '打开另一份文档前是否保存？',
    buttons: ['保存', '不保存', '取消'],
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
  const detailParts = [];
  if (info && Number.isFinite(info.savedAt) && info.savedAt > 0) {
    detailParts.push(`最后修改：${new Date(info.savedAt).toLocaleString('zh-CN')}`);
  }
  detailParts.push(info && info.filePath ? `文档：${info.filePath}` : '文档：未命名（未保存过）');
  const result = await dialog.showMessageBox(context.window, {
    type: 'warning',
    title: '恢复未保存内容',
    message: '检测到上次未保存的内容',
    detail: detailParts.join('\n') + '\n\n是否恢复到编辑器？',
    buttons: ['恢复', '放弃'],
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
    if (!ready) throw new Error('打印内容渲染超时');

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
          else reject(new Error(failureReason || '打印失败'));
        });
      });
      return { action: 'print', canceled: Boolean(printResult.canceled) };
    }
    throw new Error('未知的打印操作');
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
  if (!isCurrentRenderer(event)) return errorResult('无效的调用来源');
  if (typeof markdown !== 'string') return errorResult('文档内容无效');
  try {
    const result = await runPrintPipeline(markdown, 'print');
    return { canceled: Boolean(result.canceled) };
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('export:document', async (event, format, markdown, suggestedPath) => {
  const context = getWindowContext(event);
  if (!context) return errorResult('无效的调用来源');
  if (typeof markdown !== 'string') return errorResult('文档内容无效');
  if (format !== 'pdf' && format !== 'html') return errorResult('不支持的导出格式');
  try {
    const defaultPath = typeof suggestedPath === 'string' && suggestedPath.trim()
      ? suggestedPath.trim()
      : `未命名.${format}`;
    const dialogResult = await dialog.showSaveDialog(context.window, {
      title: format === 'pdf' ? '导出 PDF' : '导出 HTML',
      defaultPath,
      filters: format === 'pdf'
        ? [{ name: 'PDF 文档', extensions: ['pdf'] }]
        : [{ name: 'HTML 文档', extensions: ['html'] }]
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

ipcMain.handle('image:saveBlob', async (event, mdFilePath, fileName, arrayBuffer) => {
  if (!isCurrentRenderer(event)) return errorResult('无效的调用来源');
  try {
    return await saveImageBuffer(mdFilePath, fileName, arrayBuffer);
  } catch (error) {
    return errorResult(error);
  }
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
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
  const showInfoDialog = (options) => {
    const window = currentWindow();
    if (!window || window.isDestroyed()) return;
    dialog.showMessageBox(window, options);
  };
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => focusWindow(createWindow()) },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => currentWindow()?.webContents.send('menu:open') },
        // Ctrl+S 实际由 before-input-event 拦截转发；这里只显示快捷键（registerAccelerator: false）。
        { label: '保存', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => currentWindow()?.webContents.send('menu:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => currentWindow()?.webContents.send('menu:saveAs') },
        { type: 'separator' },
        { label: '打印…', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('print') },
        {
          label: '导出',
          submenu: [
            { label: 'PDF…', click: () => sendCommand('export', { format: 'pdf' }) },
            { label: 'HTML…', click: () => sendCommand('export', { format: 'html' }) },
          ]
        },
        { type: 'separator' },
        {
          label: '最近打开',
          submenu: recentEntries.length ? [
            ...recentEntries.map((entry) => ({
              label: path.basename(entry.path),
              click: () => {
                openDocumentWindow(entry.path);
              }
            })),
            { type: 'separator' },
            { label: '清除最近打开记录', click: clearRecentDocuments },
          ] : [{ label: '（暂无记录）', enabled: false }]
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => sendCommand('undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendCommand('redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', click: () => sendCommand('selectAll') },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') },
        { label: '查找下一个', accelerator: 'F3', click: () => sendCommand('findNext') },
        { label: '查找上一个', accelerator: 'Shift+F3', click: () => sendCommand('findPrevious') },
        { label: '替换…', accelerator: 'CmdOrCtrl+H', click: () => sendCommand('replace') }
      ]
    },
    {
      label: '段落',
      submenu: [
        { label: '正文', accelerator: 'CmdOrCtrl+0', click: () => sendCommand('heading', { level: 0 }) },
        ...Array.from({ length: 6 }, (_, index) => ({
          label: `${index + 1} 级标题`,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: () => sendCommand('heading', { level: index + 1 })
        })),
        { type: 'separator' },
        { label: '引用块', click: () => sendCommand('blockQuote') },
        { label: '无序列表', click: () => sendCommand('bulletList') },
        { label: '有序列表', click: () => sendCommand('orderedList') },
        { label: '任务列表', click: () => sendCommand('taskList') },
        { label: '代码块', accelerator: 'CmdOrCtrl+Shift+K', click: () => sendCommand('codeBlock') }
      ]
    },
    {
      label: '格式',
      submenu: [
        { label: '加粗', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('bold') },
        { label: '斜体', accelerator: 'CmdOrCtrl+I', click: () => sendCommand('italic') },
        { label: '删除线', click: () => sendCommand('strike') },
        { label: '行内代码', click: () => sendCommand('code') },
        { type: 'separator' },
        { label: '插入链接…', accelerator: 'CmdOrCtrl+K', click: () => sendCommand('popup', { name: 'link' }) }
      ]
    },
    {
      label: '插入',
      submenu: [
        { label: '图片…', click: () => sendCommand('popup', { name: 'image' }) },
        { label: '链接…', click: () => sendCommand('popup', { name: 'link' }) },
        { label: '表格…', click: () => sendCommand('popup', { name: 'table' }) },
        { label: '代码块', click: () => sendCommand('codeBlock') },
        { label: '水平分割线', click: () => sendCommand('hr') },
        { label: '日期时间', click: () => sendCommand('dateTime') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '显示/隐藏文件侧边栏', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendCommand('toggleSidebar') },
        { label: '大纲面板', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('showOutline') },
        { label: '专注模式', accelerator: 'F8', click: () => sendCommand('toggleFocus') },
        { type: 'separator' },
        { label: '切换源码/所见即所得', accelerator: 'CmdOrCtrl+/', click: () => sendCommand('toggleMode') },
        { type: 'separator' },
        { label: '切换主题', accelerator: 'CmdOrCtrl+Shift+T', click: () => currentWindow()?.webContents.send('menu:toggleTheme') },
        {
          label: '跟随系统主题',
          type: 'checkbox',
          checked: preferences.theme === 'system',
          click: () => {
            updatePreferences({ theme: 'system' });
            for (const context of windowContexts.values()) {
              context.window?.webContents.send('editor:command', 'followSystemTheme');
            }
          }
        },
        {
          label: '自动保存',
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
          label: '字号',
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
          label: '正文字体',
          submenu: [
            { label: '跟随主题', type: 'radio', checked: !preferences.editorFontFamily, click: () => { updatePreferences({ editorFontFamily: '' }); sendCommand('setFontFamily', { family: '' }); } },
            { label: '无衬线', type: 'radio', checked: preferences.editorFontFamily === 'sans', click: () => { updatePreferences({ editorFontFamily: 'sans' }); sendCommand('setFontFamily', { family: 'sans' }); } },
            { label: '衬线', type: 'radio', checked: preferences.editorFontFamily === 'serif', click: () => { updatePreferences({ editorFontFamily: 'serif' }); sendCommand('setFontFamily', { family: 'serif' }); } },
            { label: '等宽', type: 'radio', checked: preferences.editorFontFamily === 'mono', click: () => { updatePreferences({ editorFontFamily: 'mono' }); sendCommand('setFontFamily', { family: 'mono' }); } },
          ],
        },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => changeZoom(0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.5) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => changeZoom(null) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '操作说明',
          click: () => showInfoDialog({
            type: 'info',
            title: '操作说明',
            message: 'Markdown阅读器操作说明',
            detail: [
              '打开文档：双击 .md 文件、右键“使用 Markdown阅读器打开”、Ctrl+O 或拖拽文件。',
              '新建文档：直接双击阅读器程序，或按 Ctrl+N。',
              '多窗口：再次通过文件关联打开其他文件夹文档会新建窗口；Ctrl+Shift+N 可新建空白窗口。',
              '保存：Ctrl+S 保存，Ctrl+Shift+S 另存为。',
              '文件侧边栏：显示当前文档目录，点击文件切换；按 Ctrl+Shift+E 可收起或展开。',
              '大纲面板：侧边栏“大纲”页列出全部标题，点击跳转；按 Ctrl+Shift+O 打开。',
              '编辑：Ctrl+/ 切换源码和所见即所得，Ctrl+F 查找，Ctrl+H 替换。',
              '打印与导出：Ctrl+P 打印，文件菜单可导出 PDF 或单文件 HTML（含图表）。',
              '主题：Ctrl+Shift+T 切换亮色和暗色主题，也可设为跟随系统；偏好会自动保存。',
              '缩放：Ctrl+滚轮或 Ctrl+= / Ctrl+- 缩放，Ctrl+0 重置。',
            ].join('\n\n')
          })
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => showInfoDialog({
          type: 'info',
          title: '关于',
          message: `Markdown阅读器 ${app.getVersion()}`,
          detail: '一个像 Typora 的 Markdown 阅读器/编辑器\n基于 Electron + Toast UI Editor\n即时渲染 · 亮/暗主题 · 免安装'
          })
        }
      ]
    }
  ];
  menuBuilt = true;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    createWindow(deferredOpenFilePath || initialStartupDocumentPath);
    deferredOpenFilePath = null;
    buildMenu();

    nativeTheme.on('updated', () => {
      const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      for (const context of windowContexts.values()) {
        context.window?.webContents.send('theme:systemChanged', theme);
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
