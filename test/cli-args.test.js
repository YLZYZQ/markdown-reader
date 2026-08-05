'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFileArg } = require('../lib/cli-args');

// 创建临时文件用于存在性校验测试。
function tmpFile(name, content = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-args-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('parseFileArg returns null when no argument is given', () => {
  assert.equal(parseFileArg(['app.exe']), null);
  assert.equal(parseFileArg([]), null);
  assert.equal(parseFileArg(null), null);
});

test('parseFileArg skips dot directory placeholder', () => {
  assert.equal(parseFileArg(['app.exe', '.']), null);
});

test('parseFileArg skips dash flags', () => {
  assert.equal(parseFileArg(['app.exe', '--no-sandbox', '-flag', '--foo=bar']), null);
});

test('parseFileArg picks the first existing file path', () => {
  const file = tmpFile('note.md');
  const result = parseFileArg(['app.exe', file]);
  assert.equal(result, file);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('parseFileArg skips non-existent paths and keeps scanning', () => {
  const file = tmpFile('note.md');
  const result = parseFileArg([
    'app.exe',
    'does-not-exist.md', // 不存在，应跳过
    file                 // 真实文件，应命中
  ]);
  assert.equal(result, file);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('parseFileArg ignores directory paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dir-'));
  const result = parseFileArg(['app.exe', dir]);
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseFileArg honors existsSync=false to skip filesystem checks', () => {
  const result = parseFileArg(['app.exe', 'C:/no/such/file.md'], { existsSync: false });
  assert.equal(result, 'C:/no/such/file.md');
});

test('parseFileArg mirrors Windows open-with argv shape', () => {
  // Windows 打开方式真实形态：exe 路径 + 目标文件
  const file = tmpFile('README.md', '# hi');
  const result = parseFileArg(['C:\\Program Files\\Markdown阅读器\\Markdown阅读器.exe', file]);
  assert.equal(result, file);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
