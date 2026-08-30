'use strict';

// Mermaid 共享逻辑：源码识别、Markdown HTML 渲染器、单元素 SVG 渲染。
// 双端可用：Node 走 module.exports；渲染进程（app.js / print.js）以 <script> 引入。
(function (root) {
  function isMermaidSource(language, source) {
    if (language === 'mermaid') return true;

    // Toast UI 新建代码块时默认使用 markup。对明显的 Mermaid 流程图兼容识别，
    // 这样旧文档无需逐个修改围栏语言；其他 markup 代码仍按普通代码显示。
    return language === 'markup' && /^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b/i.test(source);
  }

  function isMermaidCodeBlock(node) {
    const language = (node.info || '').trim().split(/\s+/, 1)[0].toLowerCase();
    return isMermaidSource(language, node.literal || '');
  }

  // Markdown 预览用：mermaid 代码块输出 <div class="mermaid-diagram"> 源码占位，
  // 由 renderMermaidInto 异步替换为 SVG。
  function createMermaidHtmlRenderer() {
    return {
      codeBlock(node, context) {
        if (!isMermaidCodeBlock(node)) return context.origin();
        context.skipChildren();
        return [
          {
            type: 'openTag',
            tagName: 'div',
            classNames: ['mermaid-diagram'],
            attributes: { contenteditable: 'false' },
            outerNewLine: true
          },
          { type: 'text', content: node.literal || '' },
          { type: 'closeTag', tagName: 'div', outerNewLine: true }
        ];
      }
    };
  }

  function configureMermaid(mermaid, theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: theme === 'dark' ? 'dark' : 'default'
    });
  }

  // 把 .mermaid-diagram 占位元素渲染为 SVG；失败时保留源码并标记错误。
  async function renderMermaidInto(element, mermaid, id, theme) {
    configureMermaid(mermaid, theme);
    const source = element.textContent || '';
    element.dataset.mermaidRendering = 'true';
    try {
      const { svg, bindFunctions } = await mermaid.render(id, source);
      if (!element.isConnected) return false;
      element.innerHTML = svg;
      element.dataset.mermaidRendered = 'true';
      element.removeAttribute('data-mermaid-rendering');
      element.removeAttribute('data-mermaid-error');
      if (bindFunctions) bindFunctions(element);
      return true;
    } catch (error) {
      if (element.isConnected) {
        element.textContent = source;
        element.dataset.mermaidRendered = 'true';
        element.dataset.mermaidError = 'true';
        element.removeAttribute('data-mermaid-rendering');
      }
      console.warn('Mermaid 图表渲染失败:', error);
      return false;
    }
  }

  const api = { configureMermaid, createMermaidHtmlRenderer, isMermaidCodeBlock, isMermaidSource, renderMermaidInto };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof window !== 'undefined' ? window : globalThis);
