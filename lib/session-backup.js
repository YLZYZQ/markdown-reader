'use strict';

// 每个窗口独立保存恢复记录；兼容旧版 session.json，读取不消费备份。
const fs = require('node:fs');
const path = require('node:path');

function sessionBackupPath(userDataDir, sessionId = 'session') {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new TypeError('Invalid backup id');
  return path.join(userDataDir, 'backup', `${sessionId}.json`);
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

function writeSessionBackup(userDataDir, session, sessionId = 'session') {
  const clean = sanitizeSession(session);
  if (!clean) return null;
  const target = sessionBackupPath(userDataDir, sessionId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(clean), 'utf8');
  fs.renameSync(temporary, target);
  return clean;
}

function readSessionBackup(userDataDir, sessionId = 'session') {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(sessionBackupPath(userDataDir, sessionId), 'utf8'));
  } catch (_) {
    return null;
  }
  return sanitizeSession(raw);
}

function clearSessionBackup(userDataDir, sessionId = 'session') {
  try {
    fs.rmSync(sessionBackupPath(userDataDir, sessionId), { force: true });
  } catch (_) { /* 清理失败不影响流程 */ }
}

function readSessionBackups(userDataDir) {
  let names;
  try { names = fs.readdirSync(path.join(userDataDir, 'backup')); }
  catch (_) { return []; }
  return names.filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))
    .map((name) => ({ id: name.slice(0, -5), session: readSessionBackup(userDataDir, name.slice(0, -5)) }))
    .filter((record) => record.session)
    .sort((a, b) => b.session.savedAt - a.session.savedAt);
}

module.exports = { clearSessionBackup, readSessionBackups, readSessionBackup, sanitizeSession, sessionBackupPath, writeSessionBackup };
