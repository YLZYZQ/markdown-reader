'use strict';

// 崩溃恢复备份：userData/backup/session.json。
// 内容变更防抖写入；保存成功/新建文档/干净关闭时清除；损坏回落 null。
const fs = require('node:fs');
const path = require('node:path');

function sessionBackupPath(userDataDir) {
  return path.join(userDataDir, 'backup', 'session.json');
}

function sanitizeSession(session) {
  if (!session || typeof session !== 'object') return null;
  if (typeof session.content !== 'string') return null;
  return {
    filePath: typeof session.filePath === 'string' ? session.filePath : null,
    baseUrl: typeof session.baseUrl === 'string' ? session.baseUrl : null,
    content: session.content,
    savedAt: Number.isFinite(session.savedAt) ? session.savedAt : 0,
  };
}

function writeSessionBackup(userDataDir, session) {
  const clean = sanitizeSession(session);
  if (!clean) return null;
  const target = sessionBackupPath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(clean), 'utf8');
  fs.renameSync(temporary, target);
  return clean;
}

function readSessionBackup(userDataDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(sessionBackupPath(userDataDir), 'utf8'));
  } catch (_) {
    return null;
  }
  return sanitizeSession(raw);
}

function clearSessionBackup(userDataDir) {
  try {
    fs.rmSync(sessionBackupPath(userDataDir), { force: true });
  } catch (_) { /* 清理失败不影响流程 */ }
}

module.exports = { clearSessionBackup, readSessionBackup, sanitizeSession, sessionBackupPath, writeSessionBackup };
