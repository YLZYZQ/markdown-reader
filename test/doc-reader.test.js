'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MAX_DOCUMENT_BYTES, readDocumentContent } = require('../lib/doc-reader');

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-reader-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('reads utf8 files without BOM as-is', async () => {
  const filePath = tempFile('plain.md', '# 标题\n正文');
  const result = await readDocumentContent(filePath);
  assert.equal(result.content, '# 标题\n正文');
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.hadBom, false);
});

test('strips UTF-8 BOM from content', async () => {
  const filePath = tempFile('bom.md', Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# 标题', 'utf8'),
  ]));
  const result = await readDocumentContent(filePath);
  assert.equal(result.content, '# 标题');
  assert.equal(result.hadBom, true);
});

test('decodes UTF-16 LE files with BOM', async () => {
  const filePath = tempFile('utf16le.md', Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('# 记事本 Unicode 文件', 'utf-16le'),
  ]));
  const result = await readDocumentContent(filePath);
  assert.equal(result.content, '# 记事本 Unicode 文件');
  assert.equal(result.encoding, 'utf-16le');
});

test('decodes UTF-16 BE files with BOM', async () => {
  // Buffer 不支持直接写 utf-16be，用 le 编码后交换字节构造 BE。
  const leBytes = Buffer.from('big endian', 'utf-16le');
  const beBytes = Buffer.alloc(leBytes.length);
  for (let i = 0; i < leBytes.length; i += 2) {
    beBytes[i] = leBytes[i + 1];
    beBytes[i + 1] = leBytes[i];
  }
  const filePath = tempFile('utf16be.md', Buffer.concat([Buffer.from([0xfe, 0xff]), beBytes]));
  const result = await readDocumentContent(filePath);
  assert.equal(result.content, 'big endian');
  assert.equal(result.encoding, 'utf-16be');
});

test('rejects files above the size limit with a readable error', async () => {
  const filePath = tempFile('huge.md', 'xxx');
  await assert.rejects(
    () => readDocumentContent(filePath, { maxBytes: 2 }),
    /文件过大/,
  );
  assert.ok(MAX_DOCUMENT_BYTES > 0);
});

test('rejects directories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-reader-test-'));
  await assert.rejects(() => readDocumentContent(dir), /不是文件/);
});

test('allows empty files', async () => {
  const filePath = tempFile('empty.md', '');
  const result = await readDocumentContent(filePath);
  assert.equal(result.content, '');
});
