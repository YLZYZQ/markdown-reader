'use strict';

// 命令行参数解析：从「打开方式」传入的 argv 中提取要打开的文档路径。
const fs = require('fs');

// argv[0] 通常是可执行文件路径；打包后「打开方式」会把目标文件作为后续参数传入。
// 跳过空值、当前目录占位（.）以及 - 开头的标志参数，返回首个真实存在的文件路径。
// options.existsSync 为 true 时会调用 fs.statSync 校验文件确实存在。
function parseFileArg(argv, options = {}) {
  if (!Array.isArray(argv)) return null;
  const checkExists = options.existsSync !== false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || arg === '.') continue;
    if (arg.startsWith('-')) continue; // 跳过 --flag 形式的参数
    if (checkExists) {
      try {
        if (!fs.statSync(arg).isFile()) continue;
      } catch (_) {
        continue; // 非文件路径，忽略后继续。
      }
    }
    return arg;
  }
  return null;
}

module.exports = { parseFileArg };
