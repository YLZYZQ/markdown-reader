'use strict';

// 主进程关闭回归：未保存文档点击关闭时必须阻止默认关闭并弹出保存确认，
// 不能在 close 回调里引用未定义的 event。

const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-close-')));
app.commandLine.appendSwitch('disable-gpu');

let promptCount = 0;
dialog.showMessageBox = async () => {
  promptCount += 1;
  return { response: 2 }; // 取消
};

let mainFailure = null;
process.on('uncaughtException', (error) => {
  mainFailure = mainFailure || error;
});

// 防止测试脚本自身被 main.js 的启动参数解析误认为要打开的文档。
const originalArgv = process.argv;
process.argv = [process.execPath];
require(path.join(__dirname, '..', 'main.js'));
process.argv = originalArgv;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let finished = false;
const timeout = setTimeout(() => finish(new Error('Close regression timed out')), 30000);

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  try {
    let win = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      win = BrowserWindow.getAllWindows()[0];
      if (win && !win.webContents.isLoading()) break;
      await wait(100);
    }
    assert.ok(win, 'Main window was not created');
    await win.webContents.executeJavaScript('window.api.setDocumentDirty(true)');
    await wait(150);

    win.close();
    await wait(400);

    assert.equal(mainFailure, null, mainFailure && mainFailure.stack);
    assert.equal(win.isDestroyed(), false, 'Dirty document window must stay open after cancel');
    assert.equal(promptCount, 1, 'Close must show the unsaved-content prompt exactly once');
    console.log('Close regression OK: dirty document cancellation keeps the window open.');
    finish();
  } catch (error) {
    finish(error);
  }
}).catch(finish);
