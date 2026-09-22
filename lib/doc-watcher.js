'use strict';

// 外部修改检测：监听文档所在目录（编辑器常用“临时文件+重命名”写盘，
// 目录监听比直接监听文件可靠），自身写入通过写入完成后的 stat 基线排除。
const fs = require('node:fs');
const path = require('node:path');

// 保留旧导出以兼容调用方；不再按时间窗口忽略外部修改。
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
  let generation = 0;
  let statRequest = 0;
  let pendingOwnWrite = null;

  function isCurrent(expectedGeneration, filePath) {
    return generation === expectedGeneration && watchedPath === filePath;
  }

  function scheduleInspection(expectedGeneration, filePath) {
    if (!isCurrent(expectedGeneration, filePath)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => inspectChange(expectedGeneration, filePath), CHANGE_DEBOUNCE_MS);
  }

  async function inspectChange(expectedGeneration, filePath) {
    if (!isCurrent(expectedGeneration, filePath)) return;
    debounceTimer = null;
    // 保存完成时读取基线可能慢于目录事件；等待它，避免把自身保存当成外部修改。
    while (pendingOwnWrite) {
      await pendingOwnWrite;
      if (!isCurrent(expectedGeneration, filePath)) return;
    }
    const request = ++statRequest;
    let current;
    try {
      current = await stat(filePath);
    } catch (_) {
      return; // 文件被删除或暂时不可见时不打扰用户。
    }
    if (!isCurrent(expectedGeneration, filePath) || request !== statRequest) return;
    const unchanged = lastKnownStat !== null &&
      current.mtimeMs === lastKnownStat.mtimeMs && current.size === lastKnownStat.size;
    lastKnownStat = current;
    if (!unchanged) onExternalChange('modified');
  }

  return {
    watch(filePath) {
      const normalized = path.resolve(filePath);
      if (watchedPath && pathKey(watchedPath) === pathKey(normalized)) return;
      this.stop();
      watchedPath = normalized;
      const expectedGeneration = generation;
      const request = ++statRequest;
      try {
        Promise.resolve(stat(normalized)).then((value) => {
          if (isCurrent(expectedGeneration, normalized) && request === statRequest) lastKnownStat = value;
        }).catch(() => {
          if (isCurrent(expectedGeneration, normalized) && request === statRequest) lastKnownStat = null;
        });
        directoryWatcher = watchDir(path.dirname(normalized), (_eventType, fileName) => {
          if (!isCurrent(expectedGeneration, normalized)) return;
          if (fileName && pathKey(path.join(path.dirname(normalized), String(fileName))) !== pathKey(normalized)) return;
          // 写盘常拆成多次事件，短暂去抖后再比对。
          scheduleInspection(expectedGeneration, normalized);
        });
        directoryWatcher.on('error', () => {
          // FSWatcher 的异步错误也要处理；已失效的 watcher 不能关闭新文档监听。
          if (isCurrent(expectedGeneration, normalized)) this.stop();
        });
      } catch (_) {
        this.stop(); // 目录监听失败（如权限问题）不影响打开文档，允许稍后重试。
      }
    },

    async markOwnWrite(filePath) {
      if (watchedPath && pathKey(watchedPath) === pathKey(filePath)) {
        const normalized = watchedPath;
        const expectedGeneration = generation;
        const request = ++statRequest;
        // 调用方须在写盘成功后立即调用并等待，不能在写盘之前记录基线。
        const write = Promise.resolve().then(() => stat(normalized)).then((value) => {
          if (isCurrent(expectedGeneration, normalized) && request === statRequest) lastKnownStat = value;
        }).catch(() => {
          if (isCurrent(expectedGeneration, normalized) && request === statRequest) lastKnownStat = null;
        });
        pendingOwnWrite = write;
        try { await write; } finally {
          if (pendingOwnWrite === write) pendingOwnWrite = null;
        }
      }
    },

    stop() {
      ++generation;
      ++statRequest;
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
      pendingOwnWrite = null;
    }
  };
}

module.exports = { createDocumentWatcher, CHANGE_DEBOUNCE_MS, EXTERNAL_CHANGE_IGNORE_WINDOW_MS };
