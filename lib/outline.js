'use strict';

// 大纲解析：逐行提取 ATX 标题（# ~ ######）与 setext 标题（=== / --- 下划线式），
// 围栏代码块内的 # 行不算标题。
// setext 规则：标题文本行不能是空行/围栏/列表等块级语法，下一行是 =+（一级）或 -+（二级）。
// 双端可用：Node 走 module.exports，渲染进程以 <script> 引入挂 window。
(function (root) {
  function looksLikePlainParagraph(line) {
    if (!line.trim()) return false;
    if (/^\s{0,3}[=\-]+\s*$/.test(line)) return false; // 下划线行本身不是标题文本
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) return false;
    if (/^(#{1,6})\s/.test(line)) return false;
    if (/^\s{0,3}>/.test(line)) return false;
    // 列表 / 引用 / 表格等行不作 setext 文本（与 CommonMark setext 限制一致取保守子集）。
    if (/^\s{0,3}([-*+]|\d{1,9}[.)])\s/.test(line)) return false;
    return true;
  }

  function extractOutline(markdown) {
    if (typeof markdown !== 'string') return [];
    const lines = markdown.split(/\r\n|\r|\n/);
    const outline = [];
    let fence = null; // { char: '`' | '~', length: number } | null

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) {
          fence = { char: marker[0], length: marker.length };
        } else if (marker[0] === fence.char && marker.length >= fence.length) {
          fence = null; // CommonMark：结束围栏长度需 ≥ 开始围栏
        }
        continue;
      }
      if (fence) continue;

      const heading = line.match(/^(#{1,6})\s+(\S.*?)\s*#*\s*$/);
      if (heading) {
        outline.push({
          level: heading[1].length,
          text: heading[2],
          line: index + 1,
        });
        continue;
      }

      const setext = line.match(/^\s{0,3}(={1,}|-{1,})\s*$/);
      if (setext && index > 0) {
        const textLine = lines[index - 1];
        if (looksLikePlainParagraph(textLine)) {
          // 文本行的上一行不能也是下划线（否则该文本行已被消费或本就是分隔符后的正文）。
          const beforeText = lines[index - 2] || '';
          if (!/^\s{0,3}(={1,}|-{1,})\s*$/.test(beforeText)) {
            outline.push({
              level: setext[1][0] === '=' ? 1 : 2,
              text: textLine.trim(),
              line: index, // 标题从文本行开始（1-based）
            });
          }
        }
      }
    }

    return outline;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractOutline };
  } else {
    root.extractOutline = extractOutline;
  }
})(typeof window !== 'undefined' ? window : globalThis);
