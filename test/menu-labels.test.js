'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MENU_LANGUAGES,
  MENU_LABELS,
  formatMenuLabel,
  getMenuLabels
} = require('../lib/menu-labels');

test('menu language values are stable', () => {
  assert.deepEqual(MENU_LANGUAGES, ['zh-CN', 'en-US']);
});

test('all menu languages provide the same keys', () => {
  const keys = Object.keys(MENU_LABELS['zh-CN']).sort();
  for (const language of MENU_LANGUAGES) {
    assert.deepEqual(Object.keys(MENU_LABELS[language]).sort(), keys, language);
  }
});

test('unknown menu language falls back to Chinese', () => {
  assert.equal(getMenuLabels('en-US').file, 'File');
  assert.equal(getMenuLabels('fr-FR').file, '文件');
});

test('menu label formatting replaces known placeholders', () => {
  assert.equal(formatMenuLabel('Version {version} / {unknown}', { version: '1.9.0' }), 'Version 1.9.0 / {unknown}');
});
