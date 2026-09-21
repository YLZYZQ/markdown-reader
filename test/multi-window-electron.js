'use strict';

// 多窗口回归：文件关联二次启动必须新建独立窗口；同一文档重复关联时聚焦既有窗口。

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectDir = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-multi-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reader-multi-docs-'));
const folderA = path.join(root, 'A');
const folderB = path.join(root, 'B');
fs.mkdirSync(folderA);
fs.mkdirSync(folderB);
const documentA = path.join(folderA, 'A文档.md');
const documentB = path.join(folderB, 'B文档.md');
fs.writeFileSync(documentA, '# A文件夹文档', 'utf8');
fs.writeFileSync(documentB, '# B文件夹文档', 'utf8');

const originalArgv = process.argv;
process.argv = [process.execPath];
require(path.join(projectDir, 'main.js'));
process.argv = originalArgv;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await condition();
    if (value) return value;
    await wait(100);
  }
  throw new Error(message);
}

function launchSecondInstance(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['.', `--user-data-dir=${userData}`, filePath], {
      cwd: projectDir,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Second instance exited with ${code}: ${stderr.trim()}`));
    });
  });
}

let finished = false;
const timeout = setTimeout(() => finish(new Error('Multi-window test timed out')), 30000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  try {
    const first = await waitFor(
      () => BrowserWindow.getAllWindows().find((window) => !window.webContents.isLoading()),
      'Initial window was not created'
    );
    const openResult = await first.webContents.executeJavaScript(`window.api.openPath(${JSON.stringify(documentA)})`);
    assert.equal(openResult.error, undefined, JSON.stringify(openResult));
    await first.webContents.executeJavaScript(
      `window.loadContent(${JSON.stringify(openResult.filePath)}, ${JSON.stringify(openResult.content)}, ${JSON.stringify(openResult.baseUrl)})`
    );
    await waitFor(
      () => first.webContents.executeJavaScript('window.editor.getMarkdown()').then((value) => value === '# A文件夹文档'),
      'Document A did not load'
    );
    const treeState = await first.webContents.executeJavaScript(`(async () => {
      const allowed = await window.api.listDirectoryForDocument(${JSON.stringify(folderA)});
      const denied = await window.api.listDirectoryForDocument(${JSON.stringify(root)});
      return {
        allowedRoot: allowed.rootPath,
        allowedFiles: allowed.entries.filter((entry) => entry.type === 'file').map((entry) => entry.name),
        deniedError: denied.error || null
      };
    })()`);
    assert.equal(treeState.allowedRoot, folderA, JSON.stringify(treeState));
    assert.deepEqual(treeState.allowedFiles, ['A文档.md'], JSON.stringify(treeState));
    assert.match(treeState.deniedError, /未授权的目录路径/, JSON.stringify(treeState));

    await launchSecondInstance(documentB);
    const second = await waitFor(
      () => BrowserWindow.getAllWindows().find((window) => window !== first && !window.webContents.isLoading()),
      'Second-instance window was not created'
    );
    await waitFor(
      () => second.webContents.executeJavaScript('window.editor.getMarkdown()').then((value) => value === '# B文件夹文档'),
      'Document B did not load'
    );

    const state = {
      count: BrowserWindow.getAllWindows().length,
      first: await first.webContents.executeJavaScript('window.editor.getMarkdown()'),
      second: await second.webContents.executeJavaScript('window.editor.getMarkdown()')
    };
    assert.equal(state.count, 2, JSON.stringify(state));
    assert.equal(state.first, '# A文件夹文档');
    assert.equal(state.second, '# B文件夹文档');

    await launchSecondInstance(documentB);
    await wait(600);
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'Re-opening the same document must not create a duplicate window');

    fs.writeFileSync(documentA, '# A文件夹文档\n\n外部修改', 'utf8');
    await waitFor(
      () => first.webContents.executeJavaScript('document.getElementById("status-info").textContent')
        .then((text) => text.includes('外部程序修改')),
      'Watcher for document A did not notify its own window'
    );
    const secondStatus = await second.webContents.executeJavaScript('document.getElementById("status-info").textContent');
    assert.equal(secondStatus.includes('外部程序修改'), false, `Watcher leaked into document B: ${secondStatus}`);

    second.close();
    await waitFor(() => second.isDestroyed(), 'Document B window did not close');
    assert.equal(first.isDestroyed(), false, 'Closing document B must not close document A');
    console.log('Multi-window regression OK: folder documents open in independent windows.');
    finish();
  } catch (error) {
    finish(error);
  }
}).catch(finish);
