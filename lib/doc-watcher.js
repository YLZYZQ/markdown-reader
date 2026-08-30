'use strict';

// 外部修改检测：监听文档所在目录（编辑器常用“临时文件+重命名”写盘，
// 目录监听比直接监听文件可靠），自身写入通过时间戳窗口排除。
const fs = require('node:fs');
const path = require('node:path');

const EXTERNAL_CHANGE_IGNORE_WINDOW_MS = 1500;
const CHANGE_DEBOUNCE_MS = 150;

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createDocumentWatcher({ onExternalChange, stat = fs.promises.stat, watchDir = fs.watch } = {}) {
  let watchedPath = null;
  let directoryWatcher = null;
  let debounceTimer = null;
  let lastKnownStat = null;
  let lastOwnWriteAt = 0;

  async function inspectChange() {
    debounceTimer = null;
    if (!watchedPath) return;
    let current;
    try {
      current = await stat(watchedPath);
    } catch (_) {
      return; // 文件被删除或暂时不可见时不打扰用户。
    }
    const ownRecentWrite = Date.now() - lastOwnWriteAt < EXTERNAL_CHANGE_IGNORE_WINDOW_MS &&
      lastKnownStat !== null && current.size === lastKnownStat.size;
    const unchanged = lastKnownStat !== null &&
      current.mtimeMs === lastKnownStat.mtimeMs && current.size === lastKnownStat.size;
    if (unchanged || ownRecentWrite) {
      lastKnownStat = current;
      return;
    }
    lastKnownStat = current;
    onExternalChange('modified');
  }

  return {
    watch(filePath) {
      const normalized = path.resolve(filePath);
      if (watchedPath && pathKey(watchedPath) === pathKey(normalized)) return;
      this.stop();
      watchedPath = normalized;
      try {
        stat(watchedPath).then((value) => { lastKnownStat = value; }).catch(() => { lastKnownStat = null; });
        directoryWatcher = watchDir(path.dirname(watchedPath), (_eventType, fileName) => {
          if (!watchedPath || (fileName && fileName !== path.basename(watchedPath))) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          // 写盘常拆成多次事件，短暂去抖后再比对。
          debounceTimer = setTimeout(inspectChange, CHANGE_DEBOUNCE_MS);
        });
      } catch (_) {
        directoryWatcher = null; // 目录监听失败（如权限问题）不影响打开文档。
      }
    },

    async markOwnWrite(filePath) {
      lastOwnWriteAt = Date.now();
      if (watchedPath && pathKey(watchedPath) === pathKey(filePath)) {
        try {
          lastKnownStat = await stat(filePath);
        } catch (_) {
          lastKnownStat = null;
        }
      }
    },

    stop() {
      if (directoryWatcher) {
        directoryWatcher.close();
        directoryWatcher = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watchedPath = null;
      lastKnownStat = null;
      lastOwnWriteAt = 0;
    }
  };
}

module.exports = { createDocumentWatcher, CHANGE_DEBOUNCE_MS, EXTERNAL_CHANGE_IGNORE_WINDOW_MS };
