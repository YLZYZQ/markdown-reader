'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  getDocumentBaseUrl,
  getMarkdownImageUrl,
  isSupportedDocumentPath,
  normalizeDocumentPath,
  sanitizeImageFileName
} = require('../lib/file-utils');

test('document paths are restricted to supported text formats', () => {
  assert.equal(isSupportedDocumentPath('notes.MD'), true);
  assert.equal(isSupportedDocumentPath('notes.txt'), true);
  assert.equal(isSupportedDocumentPath('notes.html'), false);
  assert.throws(() => normalizeDocumentPath('notes.html'), /仅支持/);
});

test('image names cannot escape the images directory', () => {
  assert.equal(sanitizeImageFileName('../chart.png'), 'chart.png');
  assert.equal(sanitizeImageFileName('subdir\\chart.jpg'), 'chart.jpg');
  assert.equal(sanitizeImageFileName('bad:name.webp'), 'bad_name.webp');
  assert.equal(sanitizeImageFileName('CON.png'), '_CON.png');
  assert.throws(() => sanitizeImageFileName('../payload.exe'), /不支持/);
});

test('markdown image URLs stay relative and encode special characters', () => {
  assert.equal(getMarkdownImageUrl('示例 图.png'), 'images/%E7%A4%BA%E4%BE%8B%20%E5%9B%BE.png');
});

test('document base URL points at the containing directory', () => {
  const filePath = path.resolve('fixtures', '文档.md');
  const baseUrl = getDocumentBaseUrl(filePath);
  assert.match(baseUrl, /^file:\/\//);
  assert.equal(decodeURIComponent(baseUrl).replace(/\\/g, '/').endsWith('/fixtures/'), true);
});
