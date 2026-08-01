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
  saveFile: (filePath, content) => ipcRenderer.invoke('file:save', filePath, content),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  confirmReplace: () => ipcRenderer.invoke('document:confirmReplace'),
  setDocumentDirty: (dirty) => ipcRenderer.send('document:setDirty', Boolean(dirty)),
  closeAfterSave: () => ipcRenderer.send('window:closeAfterSave'),
  getSystemTheme: () => ipcRenderer.invoke('theme:getSystem'),

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

  // 系统主题变化
  onSystemThemeChanged: (cb) => on('theme:systemChanged', cb)
});
