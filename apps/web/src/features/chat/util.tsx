import * as React from 'react';
import type { SessionStatus } from '@vibe/shared';
import { cn } from '@/lib/utils';

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto', style: 'short' });

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'gerade eben';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 7 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Re-render every `ms` (for relative times). */
export function useTick(ms = 60_000) {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'Startet…',
  idle: 'Bereit',
  running: 'Arbeitet…',
  awaiting_approval: 'Wartet auf dich',
  error: 'Fehler',
  stopped: 'Beendet',
};

export function StatusDot({ status, className }: { status: SessionStatus | null | undefined; className?: string }) {
  const color =
    status === 'running' || status === 'starting'
      ? 'bg-brand'
      : status === 'awaiting_approval'
        ? 'bg-warning'
        : status === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40';
  const pulse = status === 'running' || status === 'starting' || status === 'awaiting_approval';
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} title={status ? STATUS_LABEL[status] : undefined}>
      {pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', color)} />}
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  );
}

const AGENT_COLORS: Record<string, string> = {
  claude: 'bg-[#d97757] text-white',
  codex: 'bg-zinc-100 text-zinc-900 dark:bg-zinc-200',
  opencode: 'bg-zinc-700 text-zinc-50',
  cline: 'bg-sky-600 text-white',
  kilo: 'bg-amber-400 text-zinc-900',
  gemini: 'bg-gradient-to-br from-sky-500 to-violet-500 text-white',
};

export function AgentAvatar({ agentId, label, className }: { agentId: string; label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] text-[9px] leading-none font-bold uppercase',
        AGENT_COLORS[agentId] ?? 'bg-muted text-foreground',
        className,
      )}
      title={label ?? agentId}
      aria-hidden
    >
      {(label ?? agentId).charAt(0)}
    </span>
  );
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Matches local dev server URLs (with or without scheme). */
export const LOCAL_URL_RE = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s)\]'"`<>]*)?/g;

export function parseLocalUrl(href: string): { port: number; path?: string } | null {
  const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s]*)?$/.exec(href.trim());
  if (!m) return null;
  const port = Number(m[1]);
  if (!port || port > 65535) return null;
  return { port, path: m[2] && m[2] !== '/' ? m[2] : undefined };
}

export function fileToImage(file: File): Promise<{ mime: string; data: string; name: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      const i = url.indexOf(',');
      resolve({ mime: file.type || 'image/png', data: url.slice(i + 1), name: file.name });
    };
    r.onerror = () => reject(r.error ?? new Error('Datei konnte nicht gelesen werden'));
    r.readAsDataURL(file);
  });
}

export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = React.useCallback(
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}
