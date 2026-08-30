'use strict';

// 判断主进程 before-input-event 收到的按键是否为保存/另存为快捷键。
// Toast UI（ProseMirror）会把 Ctrl+S / Ctrl+Shift+S 绑定为删除线并吞掉菜单加速键，
// 因此这两个组合键必须在主进程提前拦截转发（lib 单元测试覆盖判断逻辑）。
function resolveSaveChord(input) {
  if (!input || input.type !== 'keyDown') return null;
  if (!input.control || input.alt || input.meta) return null;
  if (input.key === 's') return input.shift ? 'saveAs' : 'save';
  if (input.key === 'S') return input.shift ? 'saveAs' : 'save'; // CapsLock 开启时 key 为 'S'
  return null;
}

module.exports = { resolveSaveChord };
