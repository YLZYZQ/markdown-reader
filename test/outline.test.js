'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractOutline } = require('../lib/outline');

test('extracts heading levels and 1-based line numbers', () => {
  const outline = extractOutline('# 一\n\ntext\n\n### 三级\n\n###### 六级');
  assert.deepEqual(outline, [
    { level: 1, text: '一', line: 1 },
    { level: 3, text: '三级', line: 5 },
    { level: 6, text: '六级', line: 7 },
  ]);
});

test('skips headings inside fenced code blocks', () => {
  const outline = extractOutline('# 前\n\n```\n# 不是标题\n```\n\n# 后');
  assert.deepEqual(outline, [
    { level: 1, text: '前', line: 1 },
    { level: 1, text: '后', line: 7 },
  ]);
});

test('fence with language marker also hides headings', () => {
  const outline = extractOutline('```js\n# comment\n```');
  assert.deepEqual(outline, []);
});

test('tilde fences are tracked separately', () => {
  const outline = extractOutline('~~~\n# not\n~~~\n\n# yes');
  assert.equal(outline.length, 1);
  assert.equal(outline[0].text, 'yes');
});

test('a fence only closes with the same marker and enough length', () => {
  // ``` 内部出现 ~~~ 与 `` 都不结束围栏
  const outline = extractOutline('```\n~~~\n# a\n``\n```\n\n# b');
  assert.deepEqual(outline, [{ level: 1, text: 'b', line: 7 }]);
});

test('closing fence longer than opening also closes', () => {
  const outline = extractOutline('````\n# a\n`````\n\n# b');
  assert.deepEqual(outline, [{ level: 1, text: 'b', line: 5 }]);
});

test('indented fences (up to 3 spaces) are recognized', () => {
  const outline = extractOutline('   ```\n# a\n   ```\n\n# b');
  assert.deepEqual(outline, [{ level: 1, text: 'b', line: 5 }]);
});

test('trailing hashes are stripped from heading text', () => {
  const outline = extractOutline('## 标题 ##\n### 混合 ###');
  assert.deepEqual(outline, [
    { level: 2, text: '标题', line: 1 },
    { level: 3, text: '混合', line: 2 },
  ]);
});

test('# without space is not a heading', () => {
  assert.deepEqual(extractOutline('#标签'), []);
});

test('7 hashes are not a heading', () => {
  assert.deepEqual(extractOutline('####### 七个'), []);
});

test('CRLF line endings keep line numbers correct', () => {
  const outline = extractOutline('# 一\r\n\r\n正文\r\n\r\n## 二');
  assert.deepEqual(outline, [
    { level: 1, text: '一', line: 1 },
    { level: 2, text: '二', line: 5 },
  ]);
});

test('empty and non-string inputs return empty array', () => {
  assert.deepEqual(extractOutline(''), []);
  assert.deepEqual(extractOutline(null), []);
  assert.deepEqual(extractOutline(undefined), []);
});
