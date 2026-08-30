// preload：通过 contextBridge 安全暴露受限 API 给渲染进程
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // 文件操作
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath),
  takeStartupDocument: () => ipcRenderer.invoke('startup:takeDocument'),
  notifyRendererReady: () => ipcRenderer.send('app:rendererReady'),
  listDirectoryForDocument: (filePath) =>
    ipcRenderer.invoke('directory:listForDocument', filePath),
  saveFile: (filePath, content) => ipcRenderer.invoke('file:save', filePath, content),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  confirmReplace: () => ipcRenderer.invoke('document:confirmReplace'),
  setDocumentDirty: (dirty) => ipcRenderer.send('document:setDirty', Boolean(dirty)),
  closeAfterSave: () => ipcRenderer.send('window:closeAfterSave'),
  stopWatchingDocument: () => ipcRenderer.send('document:stopWatching'),
  getSystemTheme: () => ipcRenderer.invoke('theme:getSystem'),
  getPreferences: () => ipcRenderer.invoke('prefs:getAll'),
  setPreference: (patch) => ipcRenderer.send('prefs:set', patch),

  // 崩溃恢复备份
  writeBackup: (session) => ipcRenderer.send('backup:write', session),
  clearBackup: () => ipcRenderer.send('backup:clear'),
  takeBackup: () => ipcRenderer.invoke('backup:take'),
  confirmBackupRestore: (info) => ipcRenderer.invoke('backup:confirmRestore', info),

  // 最近打开
  getRecentDocuments: () => ipcRenderer.invoke('recent:get'),

  // 打印与导出（渲染进程传当前 markdown 快照与建议保存路径）
  printDocument: (markdown) => ipcRenderer.invoke('print:document', markdown),
  exportDocument: (format, markdown, suggestedPath) =>
    ipcRenderer.invoke('export:document', format, markdown, suggestedPath),

  // Toast UI addImageBlobHook 用：传 ArrayBuffer 给主进程存盘
  saveImageBlob: (mdFilePath, fileName, arrayBuffer) =>
    ipcRenderer.invoke('image:saveBlob', mdFilePath, fileName, arrayBuffer),

  // 菜单事件监听
  onMenuOpen: (cb) => on('menu:open', cb),
  onMenuSave: (cb) => on('menu:save', cb),
  onMenuSaveAs: (cb) => on('menu:saveAs', cb),
  onMenuToggleTheme: (cb) => on('menu:toggleTheme', cb),
  onEditorCommand: (cb) => on('editor:command', cb),
  onSaveBeforeClose: (cb) => on('document:saveBeforeClose', cb),
  onSystemOpenDocument: (cb) => on('system:openDocument', cb),

  // 系统主题变化
  onSystemThemeChanged: (cb) => on('theme:systemChanged', cb),
  onZoomLevelChanged: (cb) => on('zoom:levelChanged', cb),

  // 文件被外部程序修改
  onFileExternalChanged: (cb) => on('file:externalChanged', cb)
});
