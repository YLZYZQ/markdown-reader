# 开源组件维护规范

本文定义本仓库如何登记直接使用的开源代码、如何更新打包产物，以及如何避免把体验参考误写成代码来源。

## 事实源

- `package.json`：声明直接依赖及其用途范围。
- `package-lock.json`：锁定直接依赖和传递依赖的精确版本。
- `THIRD_PARTY_NOTICES.md`：登记直接依赖的版本、许可证、上游项目与本项目使用方式。
- `THIRD_PARTY_LICENSES.md`：由生产依赖闭包自动生成的运行时传递依赖许可证清单。
- `renderer/tui-editor/editor-bundle.js`：由 `npm run build:renderer` 生成的打包产物，不手工编辑。

## 依赖分级

1. **运行时直接依赖**：应用运行或发布包内包含其代码/二进制的包，必须在 `THIRD_PARTY_NOTICES.md` 的“运行时”范围登记。
2. **构建工具直接依赖**：只参与开发、打包或资源编辑的包，必须在同一清单的“构建工具”范围登记。
3. **传递依赖**：由直接依赖带入的包，不手工重复登记；以 `package-lock.json` 为完整版本事实源。
4. **体验参考**：可用“体验接近成熟商业产品”描述目标，不得表述为复制或参考其代码，也不得暗示商标授权或官方关联。

## 变更流程

新增或升级直接依赖时：

1. 使用 npm 更新 `package.json` 与 `package-lock.json`。
2. 在 `THIRD_PARTY_NOTICES.md` 登记组件名、`package-lock.json` 中的精确版本、许可证、上游仓库和具体使用方式。
3. 如组件代码进入浏览器端，运行 `npm run build:renderer` 重建 `editor-bundle.js`，并确认相关 CSS/语言文件来源仍在清单中。
4. 检查许可证。MIT 以外的许可证必须单独确认 redistribution、source availability 与 notice 要求，并补充必要文本或发布流程。
5. 运行 `npm run notices:update` 刷新传递依赖清单，再运行 `npm run notices:check` 和与改动相关的测试。

## 发布要求

- 仓库保留项目 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与 `THIRD_PARTY_LICENSES.md`。
- 安装包与免安装包均包含上述三份文件。
- Electron 运行时自带的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` 不做删除或改名。
- 新增可分发开源组件时，必须先满足清单与许可证文本要求，再生成 release。

## 禁止事项

- 不将闭源商业产品代码写入仓库。
- 不把商业产品名称写成代码来源、赞助方、合作方或商标授权方。
- 不手工修改 `renderer/tui-editor/editor-bundle.js` 中的第三方代码；应更新依赖后重新生成。
- 不直接引用传递依赖而不声明；需要直接 `import` 时先加入 `package.json`，再更新清单。
