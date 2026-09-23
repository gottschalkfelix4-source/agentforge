import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

let configured = false;

/** Use the bundled monaco-editor package (no CDN). */
export function setupMonaco() {
  if (configured) return;
  configured = true;
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      return new editorWorker();
    },
  };
  // Workspace files are not a TS project here; avoid red squiggles for unresolved imports.
  const diag = { noSemanticValidation: true, noSyntaxValidation: false };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diag);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diag);
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    jsx: monaco.languages.typescript.JsxEmit.Preserve,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
  });

  monaco.editor.defineTheme('vibe-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1c1c1f',
      'editorGutter.background': '#1c1c1f',
      'editor.lineHighlightBackground': '#ffffff08',
      'editorLineNumber.foreground': '#52525b',
      'editorLineNumber.activeForeground': '#a1a1aa',
      'editorWidget.background': '#232326',
    },
  });
  monaco.editor.defineTheme('vibe-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#00000006',
      'editorLineNumber.foreground': '#a1a1aa',
    },
  });
  loader.config({ monaco });
}
