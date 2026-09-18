'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_PREFERENCES,
  boundsIntersectDisplay,
  loadPreferences,
  savePreferences,
  sanitizePreferences,
} = require('../lib/preferences');

function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-test-'));
  const filePath = path.join(dir, 'preferences.json');
  if (content !== undefined) fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

const DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

test('missing file falls back to defaults', () => {
  assert.deepEqual(loadPreferences(tempFile()), DEFAULT_PREFERENCES);
});

test('corrupt JSON falls back to defaults', () => {
  assert.deepEqual(loadPreferences(tempFile('{ not json')), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(tempFile('')), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(tempFile('null')), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(tempFile('[]')), DEFAULT_PREFERENCES);
});

test('valid fields are kept, invalid ones fall back', () => {
  const prefs = sanitizePreferences({
    theme: 'dark',
    zoomLevel: 2.5,
    windowBounds: { x: 10, y: 20, width: 1280, height: 800, maximized: true },
    unknownField: 'ignored',
  });
  assert.equal(prefs.theme, 'dark');
  assert.equal(prefs.zoomLevel, 2.5);
  assert.deepEqual(prefs.windowBounds, { x: 10, y: 20, width: 1280, height: 800, maximized: true });
  assert.equal('unknownField' in prefs, false);
});

test('invalid theme and zoom fall back to defaults', () => {
  const prefs = sanitizePreferences({ theme: 'solarized', zoomLevel: 99 });
  assert.equal(prefs.theme, 'system');
  assert.ok(prefs.zoomLevel <= 7.27);
  const nan = sanitizePreferences({ zoomLevel: 'abc', windowBounds: { x: NaN, y: 0, width: 800, height: 600 } });
  assert.equal(nan.zoomLevel, 0);
});

test('window bounds below minimum size are rejected', () => {
  assert.equal(sanitizePreferences({ windowBounds: { x: 0, y: 0, width: 100, height: 100 } }).windowBounds, null);
  assert.equal(sanitizePreferences({ windowBounds: { x: 0, y: 0, width: NaN, height: NaN } }).windowBounds, null);
  const ok = sanitizePreferences({ windowBounds: { x: -50, y: -50, width: 1280, height: 800 } }).windowBounds;
  assert.equal(ok.width, 1280);
});

test('save + load roundtrip preserves values', () => {
  const filePath = tempFile();
  const saved = savePreferences(filePath, { theme: 'dark', zoomLevel: 1.5, windowBounds: { x: 5, y: 6, width: 1280, height: 800, maximized: false } });
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(loadPreferences(filePath), saved);
  assert.equal(fs.existsSync(filePath + '.tmp'), false, 'temp file must be renamed away');
});

test('savePreferences creates missing directories', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-test-')), 'nested', 'deeper');
  const filePath = path.join(dir, 'preferences.json');
  savePreferences(filePath, { theme: 'light' });
  assert.equal(loadPreferences(filePath).theme, 'light');
});

test('boundsIntersectDisplay accepts on-screen and rejects off-screen', () => {
  assert.equal(boundsIntersectDisplay({ x: 100, y: 100, width: 800, height: 600 }, [DISPLAY]), true);
  assert.equal(boundsIntersectDisplay({ x: -400, y: 100, width: 800, height: 600 }, [DISPLAY]), true, 'partially visible counts');
  assert.equal(boundsIntersectDisplay({ x: 2000, y: 100, width: 800, height: 600 }, [DISPLAY]), false);
  assert.equal(boundsIntersectDisplay(null, [DISPLAY]), false);
  assert.equal(boundsIntersectDisplay({ x: 0, y: 0, width: 800, height: 600 }, []), false);
});

test('bounds expressed as raw display rects also work', () => {
  assert.equal(boundsIntersectDisplay({ x: 10, y: 10, width: 50, height: 50 }, [{ x: 0, y: 0, width: 100, height: 100 }]), true);
});

test('v1.4 fields: autoSave, editorFontSize, editorFontFamily', () => {
  const prefs = sanitizePreferences({ autoSave: true, editorFontSize: 20, editorFontFamily: 'serif' });
  assert.equal(prefs.autoSave, true);
  assert.equal(prefs.editorFontSize, 20);
  assert.equal(prefs.editorFontFamily, 'serif');
});

test('v1.4 defaults when absent', () => {
  const prefs = sanitizePreferences({});
  assert.equal(prefs.autoSave, false);
  assert.equal(prefs.editorFontSize, 16);
  assert.equal(prefs.editorFontFamily, '');
});

test('v1.4 invalid values fall back (font size clamp, family whitelist, autoSave strict)', () => {
  const prefs = sanitizePreferences({
    autoSave: 'yes',
    editorFontSize: 99,
    editorFontFamily: 'comic-sans',
  });
  assert.equal(prefs.autoSave, false);
  assert.equal(prefs.editorFontSize, 28);
  assert.equal(prefs.editorFontFamily, '');
});

test('readingLineWidth accepts only 640/780/960', () => {
  assert.equal(sanitizePreferences({ readingLineWidth: 960 }).readingLineWidth, 960);
  assert.equal(sanitizePreferences({ readingLineWidth: '780' }).readingLineWidth, 780);
  assert.equal(sanitizePreferences({ readingLineWidth: 800 }).readingLineWidth, 780);
  assert.equal(sanitizePreferences({ readingLineWidth: 'wide' }).readingLineWidth, 780);
});

test('typewriterMode only accepts true', () => {
  assert.equal(sanitizePreferences({ typewriterMode: true }).typewriterMode, true);
  assert.equal(sanitizePreferences({ typewriterMode: false }).typewriterMode, false);
  assert.equal(sanitizePreferences({ typewriterMode: 'yes' }).typewriterMode, false);
});
