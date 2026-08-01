'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSupportedDocumentPath, normalizeDocumentPath } = require('./file-utils');

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

async function listDocumentTree(documentPath, options = {}) {
  const normalizedDocumentPath = normalizeDocumentPath(documentPath);
  const rootPath = path.dirname(normalizedDocumentPath);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxScannedEntries = options.maxScannedEntries ?? DEFAULT_MAX_SCANNED_ENTRIES;
  let entryCount = 0;
  let scannedEntryCount = 0;
  let truncated = false;

  async function visit(directoryPath, depth) {
    if (depth > maxDepth) {
      truncated = true;
      return [];
    }

    let directoryEntries;
    try {
      directoryEntries = await fsp.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) throw error;
      return [];
    }

    const entries = [];
    for (const directoryEntry of directoryEntries) {
      scannedEntryCount += 1;
      if (scannedEntryCount > maxScannedEntries) {
        truncated = true;
        break;
      }
      if (entryCount >= maxEntries) {
        truncated = true;
        break;
      }
      if (directoryEntry.isSymbolicLink()) continue;

      const entryPath = path.join(directoryPath, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        if (shouldSkipDirectory(directoryEntry.name)) continue;
        const children = await visit(entryPath, depth + 1);
        if (children.length === 0) continue;
        entryCount += 1;
        entries.push({
          type: 'directory',
          name: directoryEntry.name,
          path: entryPath,
          children,
        });
      } else if (directoryEntry.isFile() && isSupportedDocumentPath(entryPath)) {
        entryCount += 1;
        entries.push({
          type: 'file',
          name: directoryEntry.name,
          path: entryPath,
        });
      }
    }

    return entries.sort(compareEntries);
  }

  return {
    rootPath,
    rootName: path.basename(rootPath) || rootPath,
    entries: await visit(rootPath, 0),
    truncated,
  };
}

module.exports = {
  compareEntries,
  listDocumentTree,
  shouldSkipDirectory,
};
