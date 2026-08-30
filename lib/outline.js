'use strict';

// 大纲解析：逐行提取 ATX 标题（# ~ ######），围栏代码块内的 # 行不算标题。
// v1.3 明确不支持 setext 标题（=== / --- 下划线式）。
// 双端可用：Node 走 module.exports，渲染进程以 <script> 引入挂 window。
(function (root) {
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
