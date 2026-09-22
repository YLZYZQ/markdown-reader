'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DICTIONARIES, t } = require('../lib/app-i18n');

function entries(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[fullKey, value]] : entries(value, fullKey);
  });
}

test('application translations have matching keys and interpolation variables', () => {
  const chinese = entries(DICTIONARIES['zh-CN']);
  const english = new Map(entries(DICTIONARIES['en-US']));
  assert.deepEqual(chinese.map(([key]) => key).sort(), [...english.keys()].sort());
  for (const [key, text] of chinese) {
    assert(english.get(key).trim(), `${key} is empty`);
    assert.deepEqual((text.match(/\{\w+\}/g) || []).sort(),
      (english.get(key).match(/\{\w+\}/g) || []).sort(), key);
  }
});

test('application translations format values and use a Chinese fallback', () => {
  assert.equal(t('en-US', 'context.headingLevel', { level: 3 }), 'Heading 3');
  assert.equal(t('zh-CN', 'context.headingLevel', { level: 3 }), '3 级标题');
  assert.equal(t('unknown', 'toolbar.open'), '打开');
});
