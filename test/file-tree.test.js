'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listDocumentTree } = require('../lib/file-tree');

test('document tree contains supported files and useful subdirectories only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-tree-'));
  try {
    await fs.mkdir(path.join(root, '章节'));
    await fs.mkdir(path.join(root, '空目录'));
    await fs.mkdir(path.join(root, '.hidden'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await Promise.all([
      fs.writeFile(path.join(root, '当前.md'), '# 当前'),
      fs.writeFile(path.join(root, '说明.txt'), '说明'),
      fs.writeFile(path.join(root, '图片.png'), 'not-an-image'),
      fs.writeFile(path.join(root, '章节', '第一章.markdown'), '# 第一章'),
      fs.writeFile(path.join(root, '.hidden', '秘密.md'), '# 秘密'),
      fs.writeFile(path.join(root, 'node_modules', '依赖.md'), '# 依赖'),
    ]);

    const result = await listDocumentTree(path.join(root, '当前.md'));
    assert.equal(result.rootPath, root);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries.map(({ type, name }) => ({ type, name })), [
      { type: 'directory', name: '章节' },
      { type: 'file', name: '当前.md' },
      { type: 'file', name: '说明.txt' },
    ]);
    assert.equal(result.entries[0].children[0].name, '第一章.markdown');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('document tree reports when its entry budget is exceeded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-tree-limit-'));
  try {
    const currentPath = path.join(root, 'current.md');
    await Promise.all([
      fs.writeFile(currentPath, ''),
      fs.writeFile(path.join(root, 'one.md'), ''),
      fs.writeFile(path.join(root, 'two.md'), ''),
    ]);

    const result = await listDocumentTree(currentPath, { maxEntries: 2 });
    assert.equal(result.entries.length, 2);
    assert.equal(result.truncated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
