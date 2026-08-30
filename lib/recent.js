'use strict';

// 最近打开记录：按路径小写去重、最新置顶、上限裁剪。纯函数便于单测。
const fs = require('node:fs');

const MAX_RECENT_ENTRIES = 10;

function normalizeRecentPath(filePath) {
  return String(filePath || '').toLowerCase();
}

function addRecentEntry(entries, filePath, openedAt, max = MAX_RECENT_ENTRIES) {
  const key = normalizeRecentPath(filePath);
  if (!key) return Array.isArray(entries) ? [...entries] : [];
  const rest = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && normalizeRecentPath(entry.path) !== key);
  return [{ path: filePath, openedAt }, ...rest].slice(0, max);
}

function loadRecent(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim() !== '')
    .slice(0, MAX_RECENT_ENTRIES)
    .map((entry) => ({
      path: entry.path,
      openedAt: Number.isFinite(entry.openedAt) ? entry.openedAt : 0,
    }));
}

function saveRecent(filePath, entries) {
  const clean = (Array.isArray(entries) ? entries : []).slice(0, MAX_RECENT_ENTRIES);
  fs.writeFileSync(filePath, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

module.exports = { MAX_RECENT_ENTRIES, addRecentEntry, loadRecent, saveRecent, normalizeRecentPath };
