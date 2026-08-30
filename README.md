# Markdown阅读器

一个基于 Electron 和 Toast UI Editor 的本地 Markdown 阅读器与编辑器，提供接近 Typora 的所见即所得体验。

## 功能

- 所见即所得与 Markdown 源码模式
- 当前文档目录侧边栏，支持目录树浏览、点击切换、刷新与折叠
- 大纲面板：列出文档全部标题，点击跳转，当前章节自动高亮（Ctrl+Shift+O）
- 打印与导出：Ctrl+P 打印，可导出 PDF 或单文件 HTML（Mermaid 图表一并渲染）
- 偏好自动保存：主题（含跟随系统）、窗口位置与大小、缩放级别、字号与正文字体，重启后还原
- 自动保存（可选）与崩溃恢复：意外退出后重新启动可恢复上次未保存的内容
- 最近打开：文件菜单快速回到最近编辑过的 10 个文档
- 代码块复制按钮：悬停代码块即可一键复制内容（源码预览与所见即所得均可用）
- 支持资源管理器右键、文件双击和已有窗口的重复打开；无文件启动时新建空白文档
- 正文、1–6 级标题、引用、列表、任务列表和代码块
- 图片、链接、表格、水平分割线和日期时间插入
- 撤销、重做、查找、替换与常用快捷键
- 亮色/暗色主题和中文界面
- 本地图片相对路径、未保存内容保护、外部修改提醒、UTF-8/UTF-16 编码兼容和便携版本

## 开发

```powershell
npm install
npm start
```

运行测试：

```powershell
npm test
npm run test:smoke
npm run test:print
```

## 构建

构建 Windows 安装包：

```powershell
npm run dist:installer
```

构建 ZIP 目录免安装版本：

```powershell
npm run dist:portable
```

产物位于 `release/`。

操作说明可在应用菜单“帮助 → 操作说明”中查看。

免安装版解压后直接运行 `MarkdownReader.exe`，程序数据保存在同目录的 `data/` 中。为了尽量保留上游 Electron 可执行文件的云信誉，免安装构建不会修改可执行文件资源；因此文件图标保持 Electron 默认样式。

> 当前发布包未使用商业代码签名证书，Windows 首次运行时可能显示 SmartScreen 提示。

## 许可证

[MIT](LICENSE)
