# 问题文档：代码审查

审查范围：`main.js`、`preload.js`、`renderer/app.js`、`renderer/index.html`、`renderer/style.css`、`lib/*.js`、构建脚本与测试。逐行通读 + 无头审计实证。
审查日期：2026-08-30。基线版本：v1.1.0（commit 45a34a3）。

> 状态标记：✅ 已修复 ｜ 🔧 已改善 ｜ ⏳ 记录暂不修（含理由）

---

## C1【高】主进程未捕获异常风险：窗口销毁后仍访问 webContents

**位置**：`main.js` createWindow() 内 `setTimeout(500)` 缩放通知闭包。

**问题**：窗口创建后 500ms 内若窗口被关闭（`mainWindow` 置 null），回调里 `mainWindow.webContents.getZoomLevel()` 直接抛 TypeError，主进程弹出未捕获异常框。`zoom-commit` 回调同样存在该风险（且该事件在 Electron 中根本不存在，见 U4）。

**修复**：删除 `zoom-commit`/`setTimeout` 方案，改用 `zoom-changed` + 自定义缩放菜单 + `did-finish-load` 后初始通知，所有路径带 `isDestroyed()` 防护。✅

## C2【高】打开文件无大小上限（同 U11）

**位置**：`main.js readDocument()`。超大文件全量读入 `utf8` 字符串 → 渲染进程 OOM/假死。

**修复**：stat 后超过 `MAX_DOCUMENT_BYTES`（30 MB）抛出明确错误，经由现有 `errorResult` 通道变成 toast 提示。✅

## C3【高】编码处理缺失：UTF-16 乱码、UTF-8 BOM 混入内容（同 U12）

**位置**：`main.js readDocument()` 固定 `readFile(…, 'utf8')`。

**问题**：UTF-16 LE/BE 文件乱码；UTF-8 BOM 以 `\uFEFF` 混入编辑器内容，参与字数统计、查找匹配，另存时行为不可预期。

**修复**：读取改为 Buffer + BOM 嗅探（`FF FE`/`FE FF` → TextDecoder utf-16le/utf-16be；`EF BB BF` → 剥离 BOM 后按 utf8 解码），该逻辑抽到 `lib/doc-reader.js` 并配单元测试。✅

## C4【高】外部修改无检测，保存可静默覆盖他人更改（同 U10）

**位置**：`main.js` 全局。

**修复**：`watchActiveDocument()`——`fs.watch` 监听当前文档父目录、过滤文件名；`document:save`/`readDocument` 成功时记录自身写入时间与大小，1.5s 内且大小一致的变更视为自身写入忽略；真实外部变更经 `file:externalChanged` 通知渲染进程。文档关闭/新建时解除监听。✅

## C5【中】Ctrl+Shift+S 加速键被渲染进程吞掉（同 U2）

**位置**：`main.js before-input-event` 只匹配了无 Shift 的 Ctrl+S；Toast UI `Strike` 键位表含 `Mod-S`。

**修复**：拦截条件扩展 `input.shift` 分支，转发 `menu:saveAs`。✅

## C6【中】渲染进程 rAF 死循环 + 死代码（同 U3）

**位置**：`app.js setupCursorTracker()`：`editor._view || editor.view || editor.getMarkdown` 赋值后从未使用；循环无条件自续且 `cancelAnimationFrame` 只在 beforeunload 才可能执行。

**修复**：整个函数按事件驱动重写，删除 rAF 与死代码。✅

## C7【中】`applyTheme` 未做同值短路（同 U9）

**位置**：`app.js`。系统主题事件每次都重建编辑器。

**修复**：同值时仅更新图标与提示，不重建。✅

## C8【中】`rebuildEditor` 丢失选区与撤销历史（同 U9）

**修复**：重建前 `getSelection()`、重建后 `setSelection()` 恢复（try/catch 包裹，失败不影响主题切换）。撤销历史受 Toast UI 重建机制限制无法保留——文档记录为已知限制。🔧

## C9【低】帮助/关于对话框未判空 mainWindow（同 U13）✅

## C10【低】菜单"保存"缺少快捷键显示（同 U7）

**修复**：`accelerator: 'CmdOrCtrl+S', registerAccelerator: false`（仅显示、不注册，避免与 before-input-event 双触发）。✅

## C11【低】拖拽提示文案与支持格式不一致（同 U8）✅

## C12【低】替换后滚动位置重置（同 U6）✅

## C13【低】查找计数显示口径不统一（同 U14）✅

## 安全与稳定性核对（无问题项，供复查）

| 项 | 结论 |
| --- | --- |
| 上下文隔离 / sandbox / nodeIntegration 关闭 | ✅ 配置正确 |
| CSP（`default-src 'none'`，脚本仅 self） | ✅ 无内联脚本依赖 |
| `will-navigate` 拦截 + `setWindowOpenHandler` 拒绝 + 外链 `shell.openExternal` 仅 http/https/mailto | ✅ |
| 文档路径授权集合（`assertAuthorizedDocument`）防渲染进程任意路径读写 | ✅ 设计有效；已知取舍：确认对话框取消后目标路径已进授权集合，但内容未加载，无实际暴露面 |
| 图片文件名清洗（Windows 保留名、路径穿越、大小上限 25MB、`wx` 独占写） | ✅ |
| 目录树（symlink 跳过、深度/条目上限、node_modules/隐藏目录排除） | ✅ |
| Mermaid `securityLevel: 'strict'` | ✅ |
| `parseFileArg` 跳过 flag/空参数并校验存在 | ✅ |

## ⏳ 记录暂不修（含理由）

| 编号 | 现象 | 不修理由 |
| --- | --- | --- |
| N1 | `document.execCommand('cut/copy/paste')` 已废弃 | Electron 下行为正确且被冒烟测试覆盖；替换为 Clipboard API 属重构（同 UX-N6） |
| N2 | `updateWordCount` 的 Markdown 字符剥离用字符类近似 | 展示性指标，误差不影响使用（同 UX-N3） |
| N3 | `openToolbarPopup` 依赖 `setTimeout(0)` 避开 mousedown 竞态 | 已有注释说明；替代方案需侵入 Toast UI 内部，风险更高 |
| N4 | 冒烟测试过滤 `TextSelection endpoint not pointing into a node with inline content` | 该日志源于对 Toast UI 传入非法选区位置的外部调用（审计中的格式试探即复现）；修复后的查找/光标代码全部使用合法位置，保留过滤作为兜底 |
| N5 | `toast()` 固定 1.8s 展示时长 | 错误类消息偏短；本轮将保存失败等关键错误已在状态栏留有持久文案，暂不改组件 |
| N6 | `package.json` 的 electron-builder `files` 未含 `docs/` | 打包产物无需携带审查文档，属预期 |
