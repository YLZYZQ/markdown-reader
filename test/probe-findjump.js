'use strict';
// 可见窗口复现：真实焦点态（输入框聚焦）下，查找的高亮与滚动行为。
// 用法：npx electron test/probe-findjump.js [headless]
// 不带 headless 参数时窗口可见（复现真实环境），自动截图并关闭。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const headless = process.argv[2] === 'headless';

ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('backup:take', () => null);
ipcMain.on('backup:write', () => {});
ipcMain.on('backup:clear', () => {});

const DOC = [
  '# Goal S1 — 后端契约件（Track B0）',
  '',
  '你是「AI修仙游戏项目」M0-MVP 开发的 S1 会话。仓库：C:\\Users\\dev\\AI修仙游戏项目。',
  '',
  '【第 0 步 · 公共公约】读 `docs/plans/M0-MVP/M0_MVP_会话Goal提示词_v0.1.md` 的「§0 公共公约」并全程执行。',
  '三条铁律：只改本 Goal 授权路径；同一问题 3 轮未解决必须登记问题清单；达标标准全勾才 push。',
  '',
  '【任务 · 开发内容】把 MVP 接口契约从文档变成可执行代码件（后端第一交付物不是 HTTP）：',
  '',
  '- D1 DTO 冻结: 按接口文档 §10–§17 逐字段实现 GameTimeDTO / PlayerSummaryDTO / PlayerDetailDTO / LocationSummaryDTO（snake_case，字段名与文档逐字一致）。',
  '- D2 枚举冻结: §13 Action 全集、§38 HealthStatus / DangerLevel / FeedScope / ActionCategory / EffortLevel。',
  '- D3 投影骨架: `backend/game/projections/` 建立 registry 骨架，`register_projection()` 与 cultivation_sim 现有 proposal / validator / reducer 模式一致。',
  '',
  '> 【必读文档 · 章节】',
  '> - docs/plans/M0-MVP/接口文档: §5–§9、§10–§17、§37–§40、§41、§50、§51',
  '> - cultivation_sim/ 现有 proposal / validator / reducer / agency runtime 代码（遵循其模式，不过度扩张）',
  '',
  '【自测方法与标准】',
  '',
  '1. `python -m pytest tests/api -q` 全绿（schema 校验、required、enum、幂等/版本语义测试）。',
  '2. frontend/mock/ 全部 17 个 fixture 通过 tests/api 的 OpenAPI schema 校验。',
  '3. 全量测试绿（635 passed / 0 failed），进度记录三处完成。',
  '',
  '- [x] D1–D7 全部交付且提交（DTO/枚举/错误码/幂等与版本/投影骨架/契约测试/17 个 fixtures, c76cab5）',
  '- [ ] tests/api 全绿（117 项）；17 个 fixtures 过 OpenAPI schema 校验',
].join('\n');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950,
    show: !headless,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 700));
  if (!headless) win.focus();
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    window.editor.changeMode('wysiwyg');
    await wait(200);
    window.editor.setMarkdown(${JSON.stringify(DOC)}, false);
    await wait(300);
  })()`);

  // 打开查找面板（真实 UI 路径），在输入框输入并聚焦 —— 完全复刻真实操作
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('btn-find').click();
    const fi = document.getElementById('find-input');
    fi.value = 'validator';
    fi.dispatchEvent(new Event('input', { bubbles: true }));
    fi.focus();
    fi.select();
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  // 拦截滚动写入 + 记录点击前状态
  await win.webContents.executeJavaScript(`(() => {
    window.__diag = { writes: [] };
    const scroller = Array.from(document.querySelectorAll('.toastui-editor .ProseMirror'))
      .find((el) => el.offsetParent !== null);
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true, get: () => 0, set: (v) => window.__diag.writes.push(Math.round(v))
    });
  })()`);

  // 点击"下一处"（与真实按钮点击一致；此时焦点在查找输入框）
  await win.webContents.executeJavaScript(`document.getElementById('btn-find-next').click()`);
  await new Promise((r) => setTimeout(r, 300));

  const diag = await win.webContents.executeJavaScript(`(() => {
    const sel = window.getSelection();
    const anchorEl = sel.anchorNode && sel.anchorNode.parentElement;
    const inEditor = Boolean(anchorEl && anchorEl.closest('.toastui-editor'));
    const inInput = Boolean(anchorEl && (anchorEl.id === 'find-input' ||
      (anchorEl.closest && anchorEl.closest('#find-panel'))));
    let pmHasFocus = null;
    try { pmHasFocus = window.editor.getCurrentModeEditor().view.hasFocus(); } catch (e) { pmHasFocus = 'err'; }
    let pmSel = null;
    try { pmSel = window.editor.getCurrentModeEditor().view.state.selection.head; } catch (e) { pmSel = 'err:' + e.message; }
    const toast = document.querySelector('.toast');
    return {
      writes: window.__diag.writes,
      inEditor, inInput,
      activeElement: document.activeElement && document.activeElement.id,
      pmHasFocus,
      pmSel,
      toastText: toast ? toast.textContent : '',
      counter: document.getElementById('find-count').textContent
    };
  })()`);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'audit-shots', 'findjump-visible.png'), img.toPNG());
  console.log(JSON.stringify(diag));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
