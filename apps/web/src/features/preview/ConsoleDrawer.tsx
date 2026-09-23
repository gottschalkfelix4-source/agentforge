import * as React from 'react';
import { AlertCircle, AlertTriangle, Ban, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { usePreviewLive, type ConsoleEntry } from './store';

type Filter = 'all' | 'error' | 'warn' | 'log';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'error', label: 'Fehler' },
  { id: 'warn', label: 'Warnungen' },
  { id: 'log', label: 'Logs' },
];

const EMPTY: ConsoleEntry[] = [];

function matches(e: ConsoleEntry, f: Filter) {
  if (f === 'all') return true;
  if (f === 'error') return e.level === 'error';
  if (f === 'warn') return e.level === 'warn';
  return e.level === 'log' || e.level === 'info' || e.level === 'debug';
}

function time(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString('de-DE', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function Row({ e }: { e: ConsoleEntry }) {
  const [open, setOpen] = React.useState(false);
  const Icon = e.level === 'error' ? AlertCircle : e.level === 'warn' ? AlertTriangle : e.level === 'info' ? Info : null;
  return (
    <div
      className={cn(
        'flex gap-2 border-b border-border/60 px-3 py-1 font-mono text-[11px] leading-relaxed',
        e.level === 'error' && 'bg-destructive/10 text-destructive',
        e.level === 'warn' && 'bg-warning/10 text-warning',
        e.level === 'debug' && 'text-muted-foreground',
      )}
    >
      <span className="w-3.5 shrink-0 pt-0.5">{Icon && <Icon className="size-3" />}</span>
      <div className="min-w-0 flex-1">
        <div className="break-words whitespace-pre-wrap">{e.text}</div>
        {e.stack && (
          <button type="button" className="text-[10px] underline opacity-70 hover:opacity-100" onClick={() => setOpen(!open)}>
            {open ? 'Stack ausblenden' : 'Stack anzeigen'}
          </button>
        )}
        {open && e.stack && <pre className="mt-1 whitespace-pre-wrap opacity-80">{e.stack}</pre>}
      </div>
      <span className="shrink-0 text-muted-foreground tabular-nums">{time(e.ts)}</span>
    </div>
  );
}

export function ConsoleDrawer({ tabId, onClose }: { tabId: string | undefined; onClose: () => void }) {
  const logs = usePreviewLive((s) => (tabId ? s.logs[tabId] : undefined)) ?? EMPTY;
  const clear = usePreviewLive((s) => s.clearLogs);
  const [filter, setFilter] = React.useState<Filter>('all');
  const list = React.useMemo(() => logs.filter((e) => matches(e, filter)), [logs, filter]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stick = React.useRef(true);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list.length]);

  const counts = React.useMemo(
    () => ({
      error: logs.filter((e) => e.level === 'error').length,
      warn: logs.filter((e) => e.level === 'warn').length,
    }),
    [logs],
  );

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="mr-1 text-xs font-medium">Konsole</span>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors',
              filter === f.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}
            {f.id === 'error' && counts.error > 0 && <span className="text-destructive">{counts.error}</span>}
            {f.id === 'warn' && counts.warn > 0 && <span className="text-warning">{counts.warn}</span>}
          </button>
        ))}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          title="Konsole leeren"
          aria-label="Konsole leeren"
          disabled={!tabId || logs.length === 0}
          onClick={() => tabId && clear(tabId)}
        >
          <Ban />
        </Button>
        <Button variant="ghost" size="icon-xs" title="Konsole schließen" aria-label="Konsole schließen" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {list.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">
            {logs.length === 0 ? 'Noch keine Ausgaben. console.* und Fehler der Vorschau erscheinen hier.' : 'Keine Einträge für diesen Filter.'}
          </div>
        ) : (
          list.map((e) => <Row key={e.id} e={e} />)
        )}
      </div>
    </div>
  );
}
