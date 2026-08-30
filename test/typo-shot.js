'use strict';
// 排版对比截图：加载一份密集的代表性文档，截取渲染效果（argv[2] = 输出文件名）。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const outName = process.argv[2] || 'typo-shot.png';

ipcMain.handle('theme:getSystem', () => 'light');
ipcMain.handle('prefs:getAll', () => ({ theme: 'system', windowBounds: null, zoomLevel: 0 }));
ipcMain.on('prefs:set', () => {});
ipcMain.handle('startup:takeDocument', () => ({ canceled: true }));
ipcMain.handle('backup:take', () => null);
ipcMain.on('backup:write', () => {});
ipcMain.on('backup:clear', () => {});

const DOC = [
  '# 项目开发计划（M0-MVP）',
  '',
  '## §0 公共公约（每个 Goal 开头引用，全文在此，单一事实源）',
  '',
  '每个会话开工后立即执行，全程遵守：',
  '',
  '1. **开工对齐**：`git fetch origin && git status -sb`（落后先 `git pull --ff-only`）；然后读根目录 `AGENTS.md`、`docs/status/开发进度.md`。',
  '2. **契约权威顺序**：`M0_AI-OFF可玩MVP_前后端接口文档_v0.1.md` + `M0_AI-OFF可玩MVP_openapi_v0.1.yaml` > 后端计划文档 > 代码现状。禁止自造字段；修改契约必先改文档/OpenAPI → 改 Fixture → 改契约测试。',
  '3. **三轮问题规则**：同一问题连续尝试 3 轮（3 次完整修复尝试）仍未解决 → 停止重试，立即登记 `docs/status/问题与风险.md`（编号 `M0MVP-S?-NN`），写明：现象 / 证据 / 已尝试方案 / 建议归属 Track。',
  '',
  '> 【必读文档 · 章节】',
  '> - docs/plans/M0-MVP/接口文档：§5–§9、§10–§17、§37–§40、§41、§50、§51',
  '> - `cultivation_sim/` 现有 proposal / validator / reducer / agency runtime 代码（遵循其模式，不过度扩张）',
  '',
  '### 自测方法与标准',
  '',
  '- `python -m pytest tests/api -q` 全绿（schema 校验、required、enum、幂等/版本语义测试）',
  '- frontend/mock/ 全部 17 个 fixture 通过 tests/api 的 OpenAPI schema 校验',
  '- 全量测试绿（635 passed / 0 failed），进度记录三处完成',
  '',
  '```python',
  'def determine_end_time(action):',
  '    return world.clock.advance(action.duration)',
  '```',
].join('\n');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1680, height: 1000, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 600));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const style = document.createElement('style');
    style.textContent = '* { animation: none !important; transition: none !important; }';
    document.head.appendChild(style);
    window.editor.setMarkdown(${JSON.stringify(DOC)}, false);
    await wait(400);
  })()`);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'audit-shots', outName), img.toPNG());
  console.log('saved ' + outName);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
