'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { listDirectoryTree, listDocumentTree } = require('../lib/file-tree');

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

test('directory tree can use a selected directory as its root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-directory-tree-'));
  try {
    const selected = path.join(root, '_selected');
    await fs.mkdir(path.join(selected, 'nested'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, 'root.md'), '# root'),
      fs.writeFile(path.join(selected, 'selected.md'), '# selected'),
      fs.writeFile(path.join(selected, 'nested', 'nested.md'), '# nested'),
    ]);

    const result = await listDirectoryTree(selected);
    assert.equal(result.rootPath, selected);
    assert.equal(result.rootName, '_selected');
    assert.deepEqual(result.entries.map(({ type, name }) => ({ type, name })), [
      { type: 'directory', name: 'nested' },
      { type: 'file', name: 'selected.md' },
    ]);
    assert.equal(result.entries[0].children[0].name, 'nested.md');
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

test('huge sibling subtree cannot starve the document directory (priorityPath)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-prio-'));
  try {
    const bigSibling = path.join(root, 'aaa-big');
    await fs.mkdir(bigSibling);
    // 字母序在前、体量超配额的兄弟目录（120 个文件，配额 100）。
    await Promise.all(Array.from({ length: 120 }, (_, i) =>
      fs.writeFile(path.join(bigSibling, `f${String(i).padStart(4, '0')}.md`), '')));
    const docDir = path.join(root, 'zzz-doc');
    await fs.mkdir(docDir);
    await Promise.all([
      fs.writeFile(path.join(docDir, '目标文档.md'), ''),
      fs.writeFile(path.join(docDir, '同目录其他文件.md'), ''),
    ]);

    const result = await listDirectoryTree(root, {
      maxEntries: 100,
      priorityPath: path.join(docDir, '目标文档.md'),
    });
    assert.equal(result.truncated, true, JSON.stringify(result));
    const docEntry = result.entries.find((entry) => entry.name === 'zzz-doc');
    assert.ok(docEntry, '文档所在目录必须保留');
    assert.deepEqual(docEntry.children.map((child) => child.name).sort(),
      ['同目录其他文件.md', '目标文档.md'], JSON.stringify(result));
    // 输出顺序保持目录优先 + 字母序。
    assert.deepEqual(result.entries.map((entry) => entry.name), ['aaa-big', 'zzz-doc']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('priorityPath file at root survives entry-cap truncation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-prio-file-'));
  try {
    await Promise.all(Array.from({ length: 150 }, (_, i) =>
      fs.writeFile(path.join(root, `a${String(i).padStart(4, '0')}.md`), '')));
    await fs.writeFile(path.join(root, 'z目标.md'), '');
    const result = await listDirectoryTree(root, {
      maxEntries: 100,
      priorityPath: path.join(root, 'z目标.md'),
    });
    assert.equal(result.truncated, true);
    assert.ok(result.entries.some((entry) => entry.name === 'z目标.md'),
      '根层的当前文档必须可见');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
