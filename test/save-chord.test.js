'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSaveChord } = require('../lib/save-chord');

test('Ctrl+S resolves to save', () => {
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 's', control: true }), 'save');
});

test('Ctrl+Shift+S resolves to saveAs', () => {
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 'S', control: true, shift: true }), 'saveAs');
});

test('CapsLock+S (key S without shift) still saves', () => {
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 'S', control: true }), 'save');
});

test('keyUp events are ignored to avoid double dispatch', () => {
  assert.equal(resolveSaveChord({ type: 'keyUp', key: 's', control: true }), null);
});

test('Alt/Meta combos are left to other shortcuts', () => {
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 's', control: true, alt: true }), null);
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 's', control: true, meta: true }), null);
});

test('plain S and non-control combos do nothing', () => {
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 's' }), null);
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 'S' }), null);
});

test('invalid input resolves to null', () => {
  assert.equal(resolveSaveChord(null), null);
  assert.equal(resolveSaveChord(undefined), null);
  assert.equal(resolveSaveChord({ type: 'keyDown', key: 'a', control: true }), null);
});
