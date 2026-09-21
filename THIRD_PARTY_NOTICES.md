# 开源组件与代码来源清单

Markdown阅读器自身采用 [MIT License](LICENSE) 发布。本文登记本项目直接声明、打包或复用的开源组件；完整运行时传递依赖清单见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

本仓库没有复制或引用任何闭源商业产品代码。商业产品只作为交互体验目标描述，不构成代码来源或商标关联。

## 直接集成组件

<!-- direct-dependencies:start -->
| 范围 | 组件 | 锁定版本 | 许可证 | 上游项目 | 本仓库使用方式 |
| --- | --- | --- | --- | --- | --- |
| 运行时 | `@toast-ui/editor` | `3.2.2` | MIT | https://github.com/nhn/tui.editor | Markdown 编辑核心、ProseMirror 编辑器封装、主题样式与中文语言包；源码打包进 `renderer/tui-editor/editor-bundle.js`，相关 CSS/语言文件保存在 `renderer/tui-editor/`。 |
| 运行时 | `@toast-ui/editor-plugin-code-syntax-highlight` | `3.1.0` | MIT | https://github.com/nhn/tui.editor | Toast UI 代码块高亮插件；打包进 `renderer/tui-editor/editor-bundle.js`，全部语言版与样式保存在 `renderer/tui-editor/`。 |
| 运行时 | `mermaid` | `11.16.1` | MIT | https://github.com/mermaid-js/mermaid | Mermaid 图表解析与渲染；打包进 `renderer/tui-editor/editor-bundle.js`。 |
| 运行时 | `prismjs` | `1.30.0` | MIT | https://github.com/PrismJS/prism | 代码语法高亮基础库与语言定义；随 Toast UI 插件打包。 |
| 运行时 | `electron` | `31.7.7` | MIT | https://github.com/electron/electron | 桌面窗口、进程模型、菜单、文件与打印能力；随安装包/便携包分发 Electron 运行时。 |
| 构建工具 | `electron-builder` | `25.1.8` | MIT | https://github.com/electron-userland/electron-builder | Windows NSIS 安装包打包。 |
| 构建工具 | `esbuild` | `0.28.1` | MIT | https://github.com/evanw/esbuild | 将 Toast UI Editor、代码高亮插件与 Mermaid 打包为浏览器可用 bundle。 |
| 构建工具 | `rcedit` | `5.0.2` | MIT | https://github.com/electron/node-rcedit | 写入 Windows EXE 图标与版本资源。 |
<!-- direct-dependencies:end -->

## 传递依赖

上述运行时组件会带入 ProseMirror、DOMPurify、D3、Cytoscape、KaTeX、marked 等传递依赖。`package-lock.json` 是其锁定版本的事实源；完整名称、版本与许可证见自动生成的 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。除非源码直接 `import`，这些包不在此表手工重复登记；若一个传递包被提升为直接依赖，必须同步加入上表。

Electron 运行时包含 Chromium 与 Node.js 等组件。Windows 发布目录会保留 Electron 分发包自带的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`，其中包含其二进制组件和第三方库的完整许可证信息。

## 维护

依赖变更时先补充上表，再运行：

```powershell
npm run notices:update
npm run notices:check
```

`notices:update` 会根据生产依赖闭包刷新传递依赖清单；`notices:check` 会校验直接依赖、锁定版本和传递依赖清单是否一致。维护流程与许可审查规则见 [docs/open-source.md](docs/open-source.md)。

## 版权与许可证声明

下表列出直接依赖的版权声明。所有列出的直接依赖均按 MIT License 授权；许可证正文在本节末尾统一提供。

| 组件 | 版权声明 |
| --- | --- |
| `@toast-ui/editor`、`@toast-ui/editor-plugin-code-syntax-highlight` | Copyright (c) 2020 NHN Cloud Corp. |
| `mermaid` | Copyright (c) 2014 - 2022 Knut Sveidqvist |
| `prismjs` | Copyright (c) 2012 Lea Verou |
| `electron` | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. |
| `electron-builder` | Copyright (c) 2015 Loopline Systems |
| `esbuild` | Copyright (c) 2020 Evan Wallace |
| `rcedit` | Copyright (c) 2013 GitHub, Inc. |

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
