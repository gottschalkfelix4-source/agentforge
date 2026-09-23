import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as monaco from 'monaco-editor';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { setupMonaco } from '@/lib/monaco';
import { useNav, useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { languageFor } from '@/features/editor/language';
import { LOCAL_URL_RE, parseLocalUrl } from './util';

setupMonaco();

// ---- remark plugin: turn bare `localhost:3000` text into links ------------------------

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

function linkifyLocal(node: MdNode) {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]!;
    if (c.type === 'link' || c.type === 'inlineCode' || c.type === 'code') continue;
    if (c.type !== 'text' || !c.value) {
      linkifyLocal(c);
      continue;
    }
    const text = c.value;
    const parts: MdNode[] = [];
    let last = 0;
    for (const m of text.matchAll(LOCAL_URL_RE)) {
      const start = m.index ?? 0;
      if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
      const raw = m[0];
      const url = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
      parts.push({ type: 'link', url, children: [{ type: 'text', value: raw }] });
      last = start + raw.length;
    }
    if (parts.length === 0) continue;
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    kids.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}

const remarkLocalhost = () => (tree: unknown) => linkifyLocal(tree as MdNode);

// ---- syntax highlighting via Monaco's colorizer (already bundled) ----------------------

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
function monacoLang(lang: string): string | null {
  const l = lang.toLowerCase();
  if (!l) return null;
  knownLangs ??= new Set(monaco.languages.getLanguages().map((x) => x.id));
  const id = LANG_ALIASES[l] ?? l;
  if (knownLangs.has(id)) return id;
  const byExt = languageFor(`x.${l}`);
  return byExt && byExt !== 'plaintext' && knownLangs.has(byExt) ? byExt : null;
}

const colorCache = new Map<string, string>();

let appliedTheme: string | null = null;
/** Monaco's colorizer output depends on the global theme (token class ids) — keep it in sync with the app. */
export function ensureMonacoTheme(theme: 'dark' | 'light') {
  const name = theme === 'dark' ? 'vibe-dark' : 'vibe-light';
  if (appliedTheme === name) return;
  appliedTheme = name;
  monaco.editor.setTheme(name);
}

function useColorized(code: string, lang: string | null, stable: boolean): string | null {
  const theme = useUi((s) => s.theme);
  ensureMonacoTheme(theme);
  const key = lang ? `${theme}\u0000${lang}\u0000${code}` : '';
  const [html, setHtml] = React.useState<string | null>(() => (key ? (colorCache.get(key) ?? null) : null));
  React.useEffect(() => {
    if (!lang || code.length > 60_000) {
      setHtml(null);
      return;
    }
    const cached = colorCache.get(key);
    if (cached) {
      setHtml(cached);
      return;
    }
    let cancelled = false;
    const t = setTimeout(
      () => {
        monaco.editor
          .colorize(code, lang, { tabSize: 2 })
          .then((out) => {
            if (colorCache.size > 500) colorCache.clear();
            colorCache.set(key, out);
            if (!cancelled) setHtml(out);
          })
          .catch(() => {});
      },
      stable ? 0 : 250,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code, lang, key, stable]);
  return html;
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      type="button"
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
      {done ? 'Kopiert' : 'Kopieren'}
    </button>
  );
}

export function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming?: boolean }) {
  const mlang = React.useMemo(() => monacoLang(lang), [lang]);
  const html = useColorized(code, mlang, !streaming);
  return (
    <div className="group/code my-2 overflow-hidden rounded-lg border border-border bg-terminal">
      <div className="flex h-7 items-center justify-between border-b border-border/70 pr-1 pl-3 text-[11px] text-muted-foreground">
        <span className="font-mono">{lang || 'text'}</span>
        <CopyButton text={code} />
      </div>
      {html ? (
        <pre
          className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-[1.55]"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-[1.55]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

// ---- markdown -----------------------------------------------------------------

const MarkdownCtx = React.createContext<{ projectId: string; streaming: boolean }>({ projectId: '', streaming: false });

function LocalLink({ port, path, children }: { port: number; path?: string; children: React.ReactNode }) {
  const { projectId } = React.useContext(MarkdownCtx);
  const openPreview = useNav((s) => s.openPreview);
  return (
    <a
      href={`#preview-${port}`}
      className="inline-flex items-center gap-0.5 text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
      title="In der Vorschau öffnen"
      onClick={(e) => {
        e.preventDefault();
        openPreview(projectId, port, path);
      }}
    >
      {children}
      <ExternalLink className="inline size-3 opacity-70" />
    </a>
  );
}

const components: Components = {
  a({ href, children }) {
    const local = href ? parseLocalUrl(href) : null;
    if (local) return <LocalLink {...local}>{children}</LocalLink>;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand">
        {children}
      </a>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, node }) {
    const text = String(children ?? '');
    const lang = /language-([\w+#.-]+)/.exec(className ?? '')?.[1] ?? '';
    const isBlock = !!lang || text.includes('\n') || node?.position?.start.line !== node?.position?.end.line;
    if (isBlock) return <CodeBlockInCtx code={text.replace(/\n$/, '')} lang={lang} />;
    const local = parseLocalUrl(text);
    if (local)
      return (
        <LocalLink {...local}>
          <code className="rounded bg-muted px-1 py-px font-mono text-[0.86em]">{text}</code>
        </LocalLink>
      );
    return <code className="rounded bg-muted px-1 py-px font-mono text-[0.86em]">{children}</code>;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[13px]">{children}</table>
      </div>
    );
  },
  th({ children, style }) {
    return <th style={style} className="border-b border-border bg-muted/60 px-2.5 py-1.5 text-left font-medium">{children}</th>;
  },
  td({ children, style }) {
    return <td style={style} className="border-b border-border/60 px-2.5 py-1.5 align-top">{children}</td>;
  },
  input({ checked, type }) {
    if (type === 'checkbox')
      return <input type="checkbox" checked={!!checked} readOnly className="mr-1.5 translate-y-px accent-brand" />;
    return null;
  },
};

function CodeBlockInCtx({ code, lang }: { code: string; lang: string }) {
  const { streaming } = React.useContext(MarkdownCtx);
  return <CodeBlock code={code} lang={lang} streaming={streaming} />;
}

const REMARK = [remarkGfm, remarkLocalhost];

// Typography without a stylesheet (styles.css is shared) — Tailwind descendant selectors.
const MD_CLASSES = [
  'text-[14px] leading-[1.65] break-words',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_p]:my-2',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-[14px] [&_h3]:font-semibold',
  '[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-medium',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5 [&_li>p]:my-0.5 [&_li::marker]:text-muted-foreground',
  '[&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-1',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_strong]:font-semibold',
].join(' ');

export const Markdown = React.memo(function Markdown({
  text,
  projectId,
  streaming = false,
  className,
}: {
  text: string;
  projectId: string;
  streaming?: boolean;
  className?: string;
}) {
  const ctx = React.useMemo(() => ({ projectId, streaming }), [projectId, streaming]);
  return (
    <MarkdownCtx.Provider value={ctx}>
      <div className={cn(MD_CLASSES, className)}>
        <ReactMarkdown remarkPlugins={REMARK} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownCtx.Provider>
  );
});
