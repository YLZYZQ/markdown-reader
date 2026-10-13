'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSupportedDocumentPath, normalizeDocumentPath, normalizeFileSystemPath } = require('./file-utils');

const fsp = fs.promises;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_SCANNED_ENTRIES = 5000;

function compareEntries(left, right) {
  if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
  return left.name.localeCompare(right.name, 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function shouldSkipDirectory(name) {
  return name.startsWith('.') || name.toLowerCase() === 'node_modules';
}

// 大小写不敏感的路径前缀判断（Windows 文件系统语义）。
function isPathPrefix(prefixPath, targetPath) {
  const prefix = String(prefixPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = String(targetPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return Boolean(prefix) && (target === prefix || target.startsWith(`${prefix}/`));
}

// 列出 directoryPath 的目录树。
// 保证（sidebar 可用性关键约束）：
// 1. 根层的直接子项永远完整枚举——打开文档的同目录文件不可能被截断吞掉；
// 2. priorityPath（当前文档）所在的子树优先于兄弟目录遍历，配额优先留给它；
// 3. 超出配额时置 truncated，由调用方提示。
async function listDirectoryTree(directoryPath, options = {}) {
  const rootPath = normalizeFileSystemPath(directoryPath);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxScannedEntries = options.maxScannedEntries ?? DEFAULT_MAX_SCANNED_ENTRIES;
  const priorityPath = options.priorityPath ? normalizeFileSystemPath(options.priorityPath) : null;
  let entryCount = 0;
  let scannedEntryCount = 0;
  let truncated = false;

  // 读取一层目录的浅表项。depth 0 不受扫描配额限制（根层必须完整），
  // 更深层在超配额时截断该层的枚举。
  async function readShallow(dirPath, depth) {
    let dirents;
    try {
      dirents = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) throw error;
      return null;
    }

    const shallow = [];
    for (const dirent of dirents) {
      scannedEntryCount += 1;
      if (depth > 0 && scannedEntryCount > maxScannedEntries) {
        truncated = true;
        break;
      }
      if (dirent.isSymbolicLink()) continue;

      const entryPath = path.join(dirPath, dirent.name);
      if (dirent.isDirectory()) {
        if (shouldSkipDirectory(dirent.name)) continue;
        shallow.push({ type: 'directory', name: dirent.name, path: entryPath });
      } else if (dirent.isFile() && isSupportedDocumentPath(entryPath)) {
        shallow.push({ type: 'file', name: dirent.name, path: entryPath });
      }
    }

    return shallow.sort(compareEntries);
  }

  async function buildTree(dirPath, depth) {
    if (depth > maxDepth) {
      truncated = true;
      return [];
    }
    const shallow = await readShallow(dirPath, depth);
    if (!shallow) return [];

    // 先为 priorityPath 所在的直接子项（文档本身或其所在目录）预构建子树：
    // 即使兄弟目录随后耗尽配额，文档同目录内容也已生成。
    // 输出顺序保持“目录优先 + 字母序”不变。
    const priorityEntry = depth === 0 && priorityPath
      ? shallow.find((entry) => isPathPrefix(entry.path, priorityPath)) || null
      : null;
    let priorityChildren = null;
    if (priorityEntry && priorityEntry.type === 'directory') {
      priorityChildren = await buildTree(priorityEntry.path, depth + 1);
    }

    const entries = [];
    let priorityIncluded = false;
    for (const entry of shallow) {
      if (entry !== priorityEntry && entryCount >= maxEntries) {
        truncated = true;
        break;
      }
      let children;
      if (entry.type === 'directory') {
        children = entry === priorityEntry ? priorityChildren : await buildTree(entry.path, depth + 1);
        if (children.length === 0) continue;
      }
      entryCount += 1;
      entries.push(entry.type === 'directory' ? { ...entry, children } : entry);
      if (entry === priorityEntry) priorityIncluded = true;
    }
    // 配额在优先项之前耗尽的兜底：当前文档所在的项必须可见。
    if (priorityEntry && !priorityIncluded) {
      truncated = true;
      if (priorityEntry.type === 'file' || (priorityChildren && priorityChildren.length)) {
        entries.push(priorityEntry.type === 'directory'
          ? { ...priorityEntry, children: priorityChildren }
          : priorityEntry);
      }
    }
    return entries;
  }

  return {
    rootPath,
    rootName: path.basename(rootPath) || rootPath,
    entries: await buildTree(rootPath, 0),
    truncated,
  };
}

async function listDocumentTree(documentPath, options = {}) {
  const normalized = normalizeDocumentPath(documentPath);
  return listDirectoryTree(path.dirname(normalized), { ...options, priorityPath: normalized });
}

module.exports = {
  compareEntries,
  isPathPrefix,
  listDirectoryTree,
  listDocumentTree,
  shouldSkipDirectory,
};
