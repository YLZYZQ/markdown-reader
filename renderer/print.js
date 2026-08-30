'use strict';

// 打印/导出渲染页：加载 markdown → 等预览渲染 → 渲染 Mermaid → 标记就绪。
// 主进程通过 executeJavaScript 调 setPrintContent，轮询 __printReady。
(function () {
  const mermaid = window.toastuiEditorBundle.mermaid;
  let editor = null;

  window.setPrintContent = async function (markdown) {
    editor = new toastui.Editor({
      el: document.getElementById('print-editor'),
      height: '100%',
      initialEditType: 'markdown',
      previewStyle: 'vertical',
      usageStatistics: false,
      theme: 'light',
      hideModeSwitch: true,
      customHTMLRenderer: window.createMermaidHtmlRenderer(),
    });
    editor.setMarkdown(String(markdown || ''));

    // 等预览完成一轮渲染（afterPreviewRender；2s 兜底防空文档挂起）。
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      editor.on('afterPreviewRender', finish);
      setTimeout(finish, 2000);
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // 预览 DOM 稳定

    // 渲染全部 Mermaid 占位（失败会保留源码并标记错误，不挂起）。
    const diagrams = document.querySelectorAll('.toastui-editor-md-preview .mermaid-diagram');
    let index = 0;
    for (const element of diagrams) {
      index += 1;
      await window.renderMermaidInto(element, mermaid, `print-diagram-${index}`, 'default');
    }
    window.__printReady = true;
  };

  // HTML 导出：只取渲染后的预览内容，CSS 由主进程读取文件内联。
  window.buildExportHtmlBody = function () {
    const preview = document.querySelector('.toastui-editor-md-preview');
    return preview ? preview.innerHTML : '';
  };
})();
