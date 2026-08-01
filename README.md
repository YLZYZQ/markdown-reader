# Markdown阅读器

一个基于 Electron 和 Toast UI Editor 的本地 Markdown 阅读器与编辑器，提供接近 Typora 的所见即所得体验。

## 功能

- 所见即所得与 Markdown 源码模式
- 正文、1–6 级标题、引用、列表、任务列表和代码块
- 图片、链接、表格、水平分割线和日期时间插入
- 撤销、重做、查找、替换与常用快捷键
- 亮色/暗色主题和中文界面
- 本地图片相对路径、未保存内容保护和便携版本

## 开发

```powershell
npm install
npm start
```

运行测试：

```powershell
npm test
npm run test:smoke
```

## 构建

构建 Windows 安装包：

```powershell
npm run dist:installer
```

构建免安装版本：

```powershell
npm run dist:portable
```

产物位于 `release/`。

> 当前发布包未使用商业代码签名证书，Windows 首次运行时可能显示 SmartScreen 提示。

## 许可证

[MIT](LICENSE)
