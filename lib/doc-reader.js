'use strict';

// 文档读取：大小上限 + BOM 编码嗅探。
const fs = require('node:fs');
const fsp = fs.promises;

const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

async function readDocumentContent(filePath, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw Object.assign(new Error('所选路径不是文件'), { i18nKey: 'errors.notFile' });
  if (stat.size > maxBytes) {
    const limit = Math.round(maxBytes / 1024 / 1024);
    throw Object.assign(new Error(`文件过大（超过 ${limit} MB），请拆分后打开`), {
      i18nKey: 'errors.documentTooLarge', i18nValues: { limit }
    });
  }

  const buffer = await fsp.readFile(filePath);
  if (buffer.length === 0) return { content: '', encoding: 'utf8', hadBom: false };

  if (buffer.subarray(0, 2).equals(UTF16LE_BOM)) {
    return { content: decodeWith(buffer.subarray(2), 'utf-16le'), encoding: 'utf-16le', hadBom: true };
  }
  if (buffer.subarray(0, 2).equals(UTF16BE_BOM)) {
    return { content: decodeWith(buffer.subarray(2), 'utf-16be'), encoding: 'utf-16be', hadBom: true };
  }
  if (buffer.subarray(0, 3).equals(UTF8_BOM)) {
    // 剥离 UTF-8 BOM：避免 \uFEFF 混入字数统计与查找匹配。
    return { content: buffer.subarray(3).toString('utf8'), encoding: 'utf8', hadBom: true };
  }
  return { content: buffer.toString('utf8'), encoding: 'utf8', hadBom: false };
}

function decodeWith(buffer, encoding) {
  // TextDecoder 非致命模式下用 U+FFFD 替换坏字节，不会抛错。
  return new TextDecoder(encoding, { fatal: false }).decode(buffer);
}

module.exports = { MAX_DOCUMENT_BYTES, readDocumentContent };
