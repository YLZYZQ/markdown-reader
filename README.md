# Markdown阅读器

一个基于 Electron 和 Toast UI Editor 的本地 Markdown 阅读器与编辑器，提供接近成熟商业产品的所见即所得体验。

## 功能

- 所见即所得与 Markdown 源码模式
- 当前文档目录侧边栏，支持目录树浏览、进入文件夹/返回上一级、点击切换与刷新
- 大纲面板：列出文档全部标题（含 Setext 下划线式，围栏代码块内的不算），点击跳转，当前章节自动高亮（Ctrl+Shift+O）
- 阅读排版：居中正文列、3 档正文宽度（640/780/960 px）、行距与间距优化、圆角引用/代码/表格
- 专注模式：淡化当前段落以外的内容，F8 进入、Esc 退出，隐藏侧栏与工具栏
- 打字机模式：光标保持视口居中（排版设置中开关，偏好自动记住）
- 阅读进度、渲染正文字数（中日韩字符与其他文字分别统计）与预计阅读时间
- 查找：输入即定位并高亮命中（Enter / Shift+Enter 上一个/下一个），替换基于当前视图可见文字——所见即所得模式不误伤链接地址等隐藏内容，全部替换单步可撤销
- 主题：浅色、奶油白、暗色与跟随系统；切换保留编辑器实例、光标选区与撤销历史
- 中文 / English 界面切换：菜单、工具栏、侧栏、搜索替换、阅读设置、状态栏、编辑弹窗和帮助页同步切换，偏好自动保存；保留文档内容、撤销历史和阅读位置
- 打印与导出：Ctrl+P 打印，可导出 PDF 或单文件 HTML（Mermaid 图表一并渲染）
- 偏好自动保存：主题（含跟随系统）、窗口位置与大小、缩放级别、字号与正文字体、正文宽度、打字机模式，重启后还原
- 版本更新提示：默认每天启动后读取一次 GitHub 最新稳定发布；发现新版本时提醒查看 Releases，可手动检查，不会自动下载或安装
- 自动保存（可选）与崩溃恢复：意外退出后重新启动可恢复上次未保存的内容
- 最近打开：文件菜单快速回到最近编辑过的 10 个文档
- 代码块复制按钮：悬停代码块即可一键复制内容（源码预览与所见即所得均可用）
- 多窗口：通过文件关联打开其他文件夹文档会新建窗口（Ctrl+Shift+N 新建空白窗口）；同一文档重复打开时聚焦既有窗口
- 支持资源管理器右键、文件双击和已有窗口的重复打开；无文件启动时新建空白文档
- 正文、1–6 级标题、引用、列表、任务列表和代码块
- 图片、链接、表格、水平分割线和日期时间插入
- 撤销、重做、查找、替换与常用快捷键
- 本地图片相对路径、未保存内容保护、外部修改提醒、UTF-8/UTF-16 编码兼容和便携版本

## 开发

```powershell
npm ci
npm start
```

运行测试：

```powershell
npm run test:all
```

单独运行检查或定位问题：

```powershell
npm run check
npm test
npm run notices:check
npm run test:smoke
npm run test:print
npm run test:reading
npm run test:search
npm run test:help
npm run test:menu-language
npm run test:document-lifecycle
npm run test:recovery
```

开发规范、状态约束和完整发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；版本修复内容见 [CHANGELOG.md](CHANGELOG.md)。

`npm test` 与 `notices:check` 会校验直接依赖、锁定版本与开源清单一致。`test:reading` 验证大纲、阅读进度、字数统计、专注模式、排版偏好与主题切换保留状态，并将浅色、深色、专注模式截图保存到 `release/reading-preview/`；`test:search` 验证长文查找定位、回绕、大小写与替换的事务性；`test:help` 验证帮助页页签、主题、紧凑布局、开源链接并生成对照截图；`test:menu-language` 验证完整中英文界面、多窗口同步、两种编辑模式的内容/选区/滚动/撤销保留、编辑弹窗、帮助标题、文件对话框、奶油白主题和便携版偏好读取；更新检查的版本比较、GitHub 响应解析和失败路径由 `npm test` 覆盖。

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

操作说明和关于页面可在应用菜单“帮助”中查看；两者跟随主界面的语言与主题。

免安装版解压后直接运行 `Markdown阅读器.exe`，程序数据保存在同目录的 `data/` 中。安装版与免安装版均使用 `build/icon.ico` 作为应用、安装器和快捷方式图标。

> 当前发布包未使用商业代码签名证书，Windows 首次运行时可能显示 SmartScreen 提示。

## 许可证

[MIT](LICENSE)。直接集成或用于构建的开源组件、锁定版本与上游项目见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，运行时传递依赖清单见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)，维护规则见 [docs/open-source.md](docs/open-source.md)。
