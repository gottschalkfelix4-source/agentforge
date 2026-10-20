// Monaco-backed code-block colorizer. Loaded on demand by Markdown.tsx (dynamic import) so the
// main bundle does not carry monaco-editor.
import * as monaco from 'monaco-editor';
import { setupMonaco } from '@/lib/monaco';
import { languageFor } from '@/features/editor/language';

setupMonaco();

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  shellscript: 'shell',
  ps: 'powershell',
  ps1: 'powershell',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
  golang: 'go',
  dockerfile: 'dockerfile',
  toml: 'ini',
  env: 'ini',
  vue: 'html',
  svelte: 'html',
  jsonc: 'json',
};

let knownLangs: Set<string> | null = null;
/** Monaco language id for a markdown fence language, or null if Monaco does not know it. */
export function monacoLang(lang: string): string | null {
  const l = lang.toLowerCase();
  if (!l) return null;
  knownLangs ??= new Set(monaco.languages.getLanguages().map((x) => x.id));
  const id = LANG_ALIASES[l] ?? l;
  if (knownLangs.has(id)) return id;
  const byExt = languageFor(`x.${l}`);
  return byExt && byExt !== 'plaintext' && knownLangs.has(byExt) ? byExt : null;
}

export function setTheme(name: string) {
  monaco.editor.setTheme(name);
}

export function colorize(code: string, lang: string): Promise<string> {
  return monaco.editor.colorize(code, lang, { tabSize: 2 });
}
