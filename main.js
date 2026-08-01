'use strict';

// 主进程：窗口、菜单、文件读写和未保存内容保护。
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const {
  getDocumentBaseUrl,
  getMarkdownImageUrl,
  normalizeDocumentPath,
  pathKey,
  sanitizeImageFileName
} = require('./lib/file-utils');
const { listDocumentTree } = require('./lib/file-tree');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const authorizedDocumentPaths = new Set();

let mainWindow = null;
let isDocumentDirty = false;
let allowWindowClose = false;
let closePromptOpen = false;

const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR ||
  (fs.existsSync(path.join(path.dirname(process.execPath), 'portable-mode'))
    ? path.dirname(process.execPath)
    : null);

if (portableExecutableDir) {
  app.setPath('userData', path.join(portableExecutableDir, 'data'));
}

function isCurrentRenderer(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
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

async function readDocument(filePath) {
  const normalized = normalizeDocumentPath(filePath);
  const stat = await fsp.stat(normalized);
  if (!stat.isFile()) throw new Error('所选路径不是文件');
  const content = await fsp.readFile(normalized, 'utf8');
  authorizeDocument(normalized);
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

function openExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      void shell.openExternal(parsed.href);
    }
  } catch (_) {
    // 忽略无效或不受支持的链接。
  }
}

async function promptForClose() {
  if (!mainWindow || mainWindow.isDestroyed() || closePromptOpen) return;
  closePromptOpen = true;
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '保存更改',
      message: '当前文档有尚未保存的更改。',
      detail: '关闭窗口前是否保存？',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });

    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (result.response === 0) {
      mainWindow.webContents.send('document:saveBeforeClose');
    } else if (result.response === 1) {
      allowWindowClose = true;
      mainWindow.close();
    }
  } finally {
    closePromptOpen = false;
  }
}

function createWindow() {
  isDocumentDirty = false;
  allowWindowClose = false;
  closePromptOpen = false;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 500,
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

  void mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('close', (event) => {
    if (allowWindowClose || !isDocumentDirty) return;
    event.preventDefault();
    void promptForClose();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalUrl(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('file:open', async (event) => {
  if (!isCurrentRenderer(event)) return errorResult('无效的调用来源');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 Markdown 文件',
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  try {
    return await readDocument(result.filePaths[0]);
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('file:openPath', async (event, filePath) => {
  if (!isCurrentRenderer(event)) return errorResult('无效的调用来源');
  try {
    return await readDocument(filePath);
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('directory:listForDocument', async (event, filePath) => {
  if (!isCurrentRenderer(event)) return errorResult('无效的调用来源');
  try {
    const documentPath = assertAuthorizedDocument(filePath);
    return await listDocumentTree(documentPath);
  } catch (error) {
    return errorResult(error);
  }
});

ipcMain.handle('file:save', async (event, filePath, content) => {
  if (!isCurrentRenderer(event)) return errorResult('无效的调用来源');
  if (typeof content !== 'string') return errorResult('文档内容无效');

  let targetPath;
  try {
    if (filePath) {
      targetPath = assertAuthorizedDocument(filePath);
    } else {
      const result = await dialog.showSaveDialog(mainWindow, {
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
  if (!isCurrentRenderer(event)) return 'cancel';
  const result = await dialog.showMessageBox(mainWindow, {
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
  if (isCurrentRenderer(event)) isDocumentDirty = Boolean(dirty);
});

ipcMain.on('window:closeAfterSave', (event) => {
  if (!isCurrentRenderer(event) || !mainWindow) return;
  isDocumentDirty = false;
  allowWindowClose = true;
  mainWindow.close();
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
    mainWindow?.webContents.send('editor:command', name, payload);
  };
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:open') },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => mainWindow?.webContents.send('menu:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow?.webContents.send('menu:saveAs') },
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
        { type: 'separator' },
        { label: '切换源码/所见即所得', accelerator: 'CmdOrCtrl+/', click: () => sendCommand('toggleMode') },
        { type: 'separator' },
        { label: '切换主题', accelerator: 'CmdOrCtrl+Shift+T', click: () => mainWindow?.webContents.send('menu:toggleTheme') },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [{
        label: '关于',
        click: () => dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '关于',
          message: 'Markdown阅读器 1.0.0',
          detail: '一个像 Typora 的 Markdown 阅读器/编辑器\n基于 Electron + Toast UI Editor\n即时渲染 · 亮/暗主题 · 免安装'
        })
      }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();

  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send(
      'theme:systemChanged',
      nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
