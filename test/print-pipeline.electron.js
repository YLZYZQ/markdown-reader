'use strict';

// M3 验证：真实 print.html 管线——渲染 markdown（含 Mermaid）→ PDF / 导出 HTML。
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let finished = false;
const timeout = setTimeout(() => finish(new Error('print pipeline test timed out')), 60000);

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) console.error('[FAIL] ' + (error.stack || error));
  else console.log('[DONE] ' + JSON.stringify(report));
  app.exit(error ? 1 : 0);
}

const report = {};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 794, height: 1123, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.webContents.on('console-message', (_e, _level, message) => {
    if (!report.console) report.console = [];
    if (report.console.length < 10) report.console.push(String(message).slice(0, 300));
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'print.html'));
  try {
    await win.webContents.executeJavaScript(`window.setPrintContent(${JSON.stringify([
      '# 项目报告',
      '',
      '正文**加粗**与 \`code\`。',
      '',
      '```mermaid',
      'flowchart LR',
      'A[输入] --> B[处理]',
      '```',
      '',
      '- 任务一',
      '- 任务二',
      '',
      '| 列 A | 列 B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'))})`);
  } catch (error) {
    finish(new Error('setPrintContent threw: ' + error.message + ' | console: ' + (report.console || []).join(' | ')));
    return;
  }
  console.error('[PROGRESS] setPrintContent resolved');

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    ready = await win.webContents.executeJavaScript('window.__printReady === true');
    if (ready) break;
  }
  report.ready = ready;
  console.error('[PROGRESS] ready=' + ready);

  const state = await win.webContents.executeJavaScript(`(() => {
    const preview = document.querySelector('.toastui-editor-md-preview');
    const sourcePane = document.querySelector('.toastui-editor.md-mode');
    return {
      sourcePaneHidden: !sourcePane || getComputedStyle(sourcePane).display === 'none',
      toolbarHidden: (() => {
        const toolbar = document.querySelector('.toastui-editor-defaultUI-toolbar');
        return !toolbar || getComputedStyle(toolbar).display === 'none';
      })(),
      svgCount: preview ? preview.querySelectorAll('.mermaid-diagram svg').length : 0,
      headingText: preview && preview.querySelector('h1') ? preview.querySelector('h1').textContent : '',
      strongCount: preview ? preview.querySelectorAll('strong').length : 0,
      tableCount: preview ? preview.querySelectorAll('table').length : 0,
      bodyLen: (window.buildExportHtmlBody() || '').length
    };
  })()`);
  Object.assign(report, state);

  const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  report.pdfHeader = pdf.slice(0, 5).toString('ascii');
  report.pdfBytes = pdf.length;
  fs.writeFileSync(path.join(__dirname, 'audit-shots', 'v1.3-sample.pdf'), pdf);

  const htmlBody = await win.webContents.executeJavaScript('window.buildExportHtmlBody()');
  report.htmlHasSvg = htmlBody.includes('<svg');
  report.htmlHasHeading = htmlBody.includes('项目报告');

  win.destroy();

  const ok = report.ready && report.sourcePaneHidden && report.toolbarHidden && report.svgCount === 1 &&
    report.headingText === '项目报告' && report.pdfHeader === '%PDF-' && report.pdfBytes > 10000 &&
    report.htmlHasSvg && report.htmlHasHeading && report.strongCount >= 1 && report.tableCount === 1;
  if (!ok) finish(new Error('print pipeline regression: ' + JSON.stringify(report)));
  else finish();
}).catch(finish);
