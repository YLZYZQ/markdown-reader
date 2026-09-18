'use strict';

// 偏好持久化：userData/preferences.json，主进程单一事实源。
// 读取容错：文件缺失/JSON 损坏/字段非法一律回落默认值，保证应用总能启动。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'system',    // 'system' | 'light' | 'dark'
  windowBounds: null, // { x, y, width, height, maximized } | null
  zoomLevel: 0,       // Electron 对数刻度（1.2^level）
  autoSave: false,    // 自动保存（修改后 2 秒静默保存）
  editorFontSize: 16, // 正文字号 12-28
  editorFontFamily: '', // '' 跟随主题 | 'sans' | 'serif' | 'mono'
  readingLineWidth: 780, // 阅读列宽 px：640 | 780 | 960
  typewriterMode: false, // 打字机模式（光标保持视口居中）
});

const THEME_VALUES = new Set(['system', 'light', 'dark']);
const FONT_FAMILIES = new Set(['', 'sans', 'serif', 'mono']);
const READING_LINE_WIDTHS = new Set([640, 780, 960]);
const ZOOM_LIMIT = 7.27;
const MIN_WINDOW = { width: 720, height: 500 };

function clampNumber(value, fallback, { min, max, integer = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(max, Math.max(min, num));
  return integer ? Math.round(clamped) : clamped;
}

// 逐字段校验并归一化；非法输入保持默认值。
function sanitizePreferences(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const prefs = { ...DEFAULT_PREFERENCES };

  if (THEME_VALUES.has(source.theme)) prefs.theme = source.theme;

  if (source.windowBounds && typeof source.windowBounds === 'object') {
    const width = clampNumber(source.windowBounds.width, 0, { min: 0, max: 20000, integer: true });
    const height = clampNumber(source.windowBounds.height, 0, { min: 0, max: 20000, integer: true });
    if (width >= MIN_WINDOW.width && height >= MIN_WINDOW.height) {
      prefs.windowBounds = {
        x: clampNumber(source.windowBounds.x, 0, { min: -100000, max: 100000, integer: true }),
        y: clampNumber(source.windowBounds.y, 0, { min: -100000, max: 100000, integer: true }),
        width,
        height,
        maximized: Boolean(source.windowBounds.maximized),
      };
    }
  }

  prefs.zoomLevel = clampNumber(
    source.zoomLevel,
    DEFAULT_PREFERENCES.zoomLevel,
    { min: -ZOOM_LIMIT, max: ZOOM_LIMIT },
  );

  prefs.autoSave = source.autoSave === true;
  prefs.editorFontSize = clampNumber(
    source.editorFontSize,
    DEFAULT_PREFERENCES.editorFontSize,
    { min: 12, max: 28, integer: true },
  );
  if (FONT_FAMILIES.has(source.editorFontFamily)) prefs.editorFontFamily = source.editorFontFamily;

  if (READING_LINE_WIDTHS.has(Number(source.readingLineWidth))) {
    prefs.readingLineWidth = Number(source.readingLineWidth);
  }
  prefs.typewriterMode = source.typewriterMode === true;

  return prefs;
}

function loadPreferences(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return { ...DEFAULT_PREFERENCES };
  }
  return sanitizePreferences(raw);
}

// 临时文件 + 原子改名，避免写一半被读取。
function savePreferences(filePath, prefs) {
  const clean = sanitizePreferences(prefs);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
  return clean;
}

// 恢复窗口前校验：bounds 必须与某个已连接显示器的工作区相交，否则视为无效。
function boundsIntersectDisplay(bounds, displays) {
  if (!bounds) return false;
  return (displays || []).some((display) => {
    const area = display.bounds || display;
    return bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y;
  });
}

module.exports = {
  DEFAULT_PREFERENCES,
  boundsIntersectDisplay,
  loadPreferences,
  savePreferences,
  sanitizePreferences,
};
