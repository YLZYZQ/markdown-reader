// 打包入口：Toast UI Editor + 代码高亮插件(全部语言) + 中文 → 单个浏览器友好 JS bundle
// CSS 单独通过 <link> 引入（已复制到 renderer/tui-editor/）
import Editor from '@toast-ui/editor';
import codeSyntaxHighlight from '@toast-ui/editor-plugin-code-syntax-highlight/dist/toastui-editor-plugin-code-syntax-highlight-all';
// 中文语言包（import 会自动注册到 Editor 的 i18n）
import '@toast-ui/editor/dist/i18n/zh-CN';

window.toastui = window.toastui || {};
window.toastui.Editor = Editor;
window.toastuiEditorBundle = {
  Editor: Editor,
  codeSyntaxHighlight: codeSyntaxHighlight
};
