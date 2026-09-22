'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.txt']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function hasAllowedExtension(filePath, extensions) {
  return typeof filePath === 'string' && extensions.has(path.extname(filePath).toLowerCase());
}

function isSupportedDocumentPath(filePath) {
  return hasAllowedExtension(filePath, MARKDOWN_EXTENSIONS);
}

function isSupportedImagePath(filePath) {
  return hasAllowedExtension(filePath, IMAGE_EXTENSIONS);
}

function normalizeDocumentPath(filePath) {
  const normalized = normalizeFileSystemPath(filePath);
  if (!isSupportedDocumentPath(normalized)) {
    throw Object.assign(new TypeError('仅支持 Markdown 或文本文件'), { i18nKey: 'errors.unsupportedDocument' });
  }
  return normalized;
}

function normalizeFileSystemPath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw Object.assign(new TypeError('文件路径无效'), { i18nKey: 'errors.invalidPath' });
  }
  return path.resolve(filePath);
}

function sanitizeImageFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.trim() === '') {
    throw Object.assign(new TypeError('图片文件名无效'), { i18nKey: 'errors.invalidImageName' });
  }

  let safeName = path.basename(fileName.trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');

  if (!safeName || safeName === '.' || safeName === '..') {
    throw Object.assign(new TypeError('图片文件名无效'), { i18nKey: 'errors.invalidImageName' });
  }
  if (WINDOWS_RESERVED_NAMES.test(safeName)) {
    safeName = `_${safeName}`;
  }
  if (!isSupportedImagePath(safeName)) {
    throw Object.assign(new TypeError('不支持该图片格式'), { i18nKey: 'errors.unsupportedImage' });
  }
  return safeName;
}

function getDocumentBaseUrl(filePath) {
  const normalized = normalizeDocumentPath(filePath);
  return pathToFileURL(path.dirname(normalized) + path.sep).href;
}

function getMarkdownImageUrl(fileName) {
  return `images/${encodeURIComponent(sanitizeImageFileName(fileName))}`;
}

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = {
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  getDocumentBaseUrl,
  getMarkdownImageUrl,
  isSupportedDocumentPath,
  isSupportedImagePath,
  normalizeFileSystemPath,
  normalizeDocumentPath,
  pathKey,
  sanitizeImageFileName
};
