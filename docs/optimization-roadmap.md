# 对标分析与优化路线

分析日期：2026-08-30（基于 v1.2.0 代码 + 无头能力探针 `test/probe-features.js` 实测）。
对标对象：Typora（收费标杆）、MarkText（开源同类，2022 年起停止维护）、Obsidian（知识库）、Zettlr（学术写作）、VS Code（通用编辑器）。

---

## 一、定位与结论

本编辑器定位：**本地 Markdown 阅读器 + 轻量即时渲染编辑器**（免安装、离线、中文、隐私）。

对标结论：核心的"即时渲染编辑"体验已经达到 MarkText 的水准（且比它维护活跃），差距集中在**阅读配套功能**（大纲、导出/打印）和**使用偏好记忆**（主题/窗口/自动保存）上。这恰好也是 MarkText 停止维护后用户流失的原因清单。

### 现有优势（保持，不动）

| 优势 | 说明 |
| --- | --- |
| 免安装 + 单目录便携 | 对比 Typora 需安装、Obsidian 需账号导入 vault |
| 完全离线 + 隐私 | 无遥测（usageStatistics 已关）、无云依赖 |
| 即时渲染（类 Typora） | 开源阵营里 MarkText 停更后的空位 |
| Mermaid 图表渲染 | 含旧文档 `markup` 语言兼容，优于多数同类 |
| 原生中文 | Typora/Obsidian 中文均靠翻译包 |

### 能力探针实测（2026-08-30）

| 能力 | 实测结果 |
| --- | --- |
| YAML front matter | ✅ 内容无损保留；❌ 不渲染为元数据块（按普通文本） |
| 数学公式 `$…$` / `$$…$$` | ❌ 保持字面文本 |
| `[TOC]` 宏 | ❌ 保持字面文本 |
| `:smile:` 表情短码 | ❌ 保持字面文本 |
| `==高亮==` 标记 | ❌ 不支持（非 GFM 标准，可忽略） |
| 脚注 `[^1]` | ⚠️ 按普通文本渲染（无跳转），需人工复核 |

---

## 二、功能矩阵对比

图例：✅ 有 ｜ ⚠️ 部分 ｜ ❌ 无

| 功能 | 本编辑器 | Typora | MarkText | Obsidian | Zettlr | VS Code |
| --- | --- | --- | --- | --- | --- | --- |
| 即时渲染编辑 | ✅ | ✅ | ✅ | ⚠️(实时预览) | ⚠️ | ⚠️(预览) |
| 源码模式 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 文件侧边栏 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **大纲/目录面板** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅(内置) |
| **导出 PDF/HTML** | ❌ | ✅ | ✅(pandoc) | ✅ | ✅(pandoc) | ⚠️(扩展) |
| **打印** | ❌ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ |
| 数学公式 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 亮/暗主题 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 主题偏好记忆 | ❌(跟随系统) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 窗口状态记忆 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 最近打开 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 自动保存 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 崩溃恢复 | ❌ | ⚠️ | ✅ | ✅(文件恢复) | ⚠️ | ⚠️ |
| 专注/打字机模式 | ❌ | ✅ | ✅ | ⚠️(插件) | ✅ | ❌ |
| 字体/字号设置 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 图片粘贴本地化 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| 图片拖拽插入 | ❌(仅打开文件) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 任务列表点击切换 | ⚠️(未验证) | ✅ | ✅ | ✅ | ✅ | ✅ |
| front matter 渲染 | ❌(无损保留) | ✅ | ⚠️ | ✅ | ✅ | ⚠️ |
| Mermaid | ✅ | ✅ | ✅ | ✅(插件) | ❌ | ✅ |
| 多标签 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 命令面板 | ❌ | ❌ | ❌ | ✅ | ⚠️ | ✅ |
| 全文搜索(目录级) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 免安装便携 | ✅ | ❌ | ⚠️ | ⚠️ | ❌ | ❌ |
| 价格 | 免费 | $14.99 | 免费(停更) | 免费(闭源) | 免费 | 免费 |

---

## 三、优化清单（按优先级）

### P0 —— 补齐"阅读器"基本功（✅ 已于 v1.3.0 完成，计划见 [v1.3-plan.md](v1.3-plan.md)）

**1. 偏好持久化：主题、窗口状态、缩放**（现有功能补完，小工作量）

现状实测：主题手动切换后重启即丢（每次启动跟随系统）；窗口固定 1200×800；缩放不记忆。Typora/Obsidian/MarkText 全部记忆。
方案：`localStorage`（或 userData 下的 JSON）持久化 `theme`（用户手动切换时记录 `manual` 标志）、窗口 bounds（`mainWindow.on('close')` 保存，createWindow 恢复并做屏幕边界校验）、zoomLevel。工作量约半天。

**2. 大纲/目录面板**（阅读长文档的核心能力，中等工作量）

现状：无。所有对标编辑器都有。
方案：从 `editor.getMarkdown()` 解析标题生成层级列表，放在侧边栏第二个 tab（与文件树并列）；点击标题 `editor.setSelection([行,1],[行,1])`（源码模式 1-based 行列已验证可行）+ 滚动；`change` 事件防抖刷新；当前光标所在标题高亮。ww 模式跳转用 `getVisibleMatches` 同款 PM 偏移映射。工作量 1-2 天。

**3. 打印 + 导出 PDF/HTML**（"阅读器"的自然延伸，小-中工作量）

现状：无。Electron 自带 `webContents.print()` 与 `printToPDF()`，成本远低于 Typora 的方案。
方案：
- 打印：菜单"文件 → 打印"，注入打印样式表（去工具栏/侧边栏/状态栏、白底黑字）后 `print({})`。
- 导出 PDF：`printToPDF({ printBackground: true })` + 另存对话框；导出前把 ww 内容整体渲染成纯净 HTML。
- 导出 HTML：直接用 Toast UI 的 markdown→HTML 输出 + 内联当前主题 CSS（单文件，双击可看）。
工作量 1-2 天。

### P1 —— 阅读体验增强（建议 v1.4）

**4. 自动保存 + 崩溃恢复**

现状：无自动保存；意外退出丢未保存内容。
方案：设置项"自动保存（修改后 2 秒）"，默认关；无论开关，编辑内容防抖写入 `userData/backup/当前文件名.md`，启动时检测到备份提示恢复。工作量 1 天。

**5. 最近打开**

现状：无。方案：主进程维护最近 10 条（含路径+时间），写 `userData/recent.json`；文件菜单"最近打开"子菜单 + 开始页展示；注意用现有 `assertAuthorizedDocument` 机制在打开时重新授权。工作量半天。

**6. 代码块复制按钮**

现状：无。阅读技术文档高频需求（docs 站标配）。方案：预览/ww 代码块 NodeView 外层挂复制按钮，`navigator.clipboard.writeText`。工作量半天。

**7. 字体/字号设置**

现状：无。中文用户阅读长文常调字号/字体（Typora/Obsidian 均有）。方案：设置面板（字号 12-24px、等宽字体选择、行高），写 CSS 变量并持久化。工作量 1 天。

**8. 数学公式（KaTeX）**

现状实测：`$$…$$` 保持字面文本。Toast UI v3 **无官方 math 插件**（v2 才有），需自行在 `customHTMLRenderer` 中拦截 math 块/行内公式交给 KaTeX 渲染（离线打包 katex.min.css + 字体）。工作量 2-3 天。学术/技术文档阅读刚需，优先级取决于目标用户。

### P2 —— 写作向增强（v2.0 方向，按需取舍）

**9. 专注/打字机模式**：Typora 招牌。ww 模式下 CSS 变暗非当前段落（专注）+ 滚动保持光标垂直居中（打字机）。纯前端，工作量 1 天。
**10. front matter 渲染**：识别文档头部 `---` 块渲染为标题下方的元数据表（Obsidian 风格），源码仍保留原文。工作量 1 天。
**11. 图片拖拽插入**：拖图片到编辑区复用 `addImageBlobHook` 本地化（现拒绝并提示）。工作量半天。
**12. 任务列表点击切换**：ww 模式复选框点击切换 `[ ]`/`[x]`（探针未能在无头环境验证交互，需人工复核后决定）。
**13. 多标签**：架构改动大（单 editor 实例 → 标签页管理），建议放在上述全部之后，或用"多窗口"替代（`second-instance` 已具备，开新文件可选新窗口）。
**14. 目录级全文搜索**：侧边栏搜索当前目录所有 md（file-tree 已能列目录，加个内容搜索）。工作量 1-2 天。

### P3 —— 生态/长线

命令面板（Ctrl+Shift+P，聚合所有命令）、多语言 i18n、Word/LaTeX 导出（依赖外部 pandoc，参考 Zettlr）、插件化架构。与"轻量阅读器"定位有张力，建议保持克制。

### 明确不做

云同步/账号体系、graph view 知识图谱、协作编辑——那是 Obsidian/Notion 的领域，与免安装单机定位冲突。

---

## 四、建议落地顺序

| 版本 | 内容 | 理由 |
| --- | --- | --- |
| v1.3 | 偏好持久化 + 大纲面板 + 打印/导出 PDF/HTML | 补齐阅读器底线，全部有成熟实现路径 |
| v1.4 | 自动保存+崩溃恢复、最近打开、代码块复制、字号设置 | 日常使用舒适度 |
| v2.0 | 数学公式、专注模式、front matter、图片拖拽 | 向写作工具扩展 |

---

## 附：来源

- [Reddit r/Markdown — Which Markdown editor is better or equal to Typora](https://www.reddit.com/r/Markdown/comments/1t4wvn8/which_markdown_editor_is_better_or_equal_to/)（MarkText 停更、替代品讨论）
- [Best Mac Markdown Editors 2026 (Medium)](https://saas-tools.medium.com/best-mac-markdown-editors-2026-i-tested-9-ive-already-switched-twice-8f915221644c)
- [Markdown Editors Compared](https://www.markdown-to-word.online/markdown-editors-comparison/)
- [docsio.co — 11 Best Markdown Editors in 2026](https://docsio.co/blog/best-markdown-editor)
- [Linux Journal — MarkText vs Typora](https://www.linuxjournal.com/content/mark-text-vs-typora-best-markdown-editor-linux)
