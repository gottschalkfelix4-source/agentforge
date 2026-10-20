import * as React from 'react';
import type { ModelCatalogEntry } from '@vibe/shared';
import { Check, ChevronDown, Cpu, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { describeModel } from './model-names';
import { formatPricing } from './cost';
import { formatTokens } from './util';

export interface ModelOption {
  id: string;
  /** Name the agent reports (ACP/Codex model lists); provider models only have the id. */
  name?: string;
}

interface Row {
  id: string;
  name: string;
  vendor: string | null;
  tags: string[];
  entry: ModelCatalogEntry | undefined;
  haystack: string;
}

const SEARCH_FROM = 8;

/** "Anthropic: Claude Opus 4.1" → "Claude Opus 4.1" (the vendor is the group heading). */
const catalogName = (name: string | null | undefined) => (name ? name.replace(/^[^:]{1,40}:\s+/, '') : null);

function toRow(m: ModelOption, entry: ModelCatalogEntry | undefined): Row {
  const label = describeModel(m.id);
  const agentName = m.name && m.name !== m.id ? m.name : null;
  const name = catalogName(entry?.name) ?? agentName ?? label.name;
  return {
    id: m.id,
    name,
    vendor: label.vendor,
    tags: label.tags,
    entry,
    haystack: `${name} ${m.id} ${label.vendor ?? ''} ${label.tags.join(' ')}`.toLowerCase(),
  };
}

/** Readable name of a model id (catalog name, agent name or the parsed id). */
export function modelDisplayName(id: string, opts?: { name?: string; catalog?: ModelCatalogEntry[] }): string {
  return toRow({ id, name: opts?.name }, opts?.catalog?.find((e) => e.id === id)).name;
}

/**
 * Model picker: full readable names grouped by vendor, the exact id underneath, and — for providers with a
 * catalog (OpenRouter) — price per million tokens and context size. Searchable when the list is long.
 */
export function ModelPicker({
  title,
  models,
  value,
  onSelect,
  catalog,
  disabled,
  footer,
  empty,
}: {
  title: string;
  models: ModelOption[];
  value: string | null | undefined;
  onSelect: (id: string) => void;
  catalog?: ModelCatalogEntry[];
  disabled?: boolean;
  footer?: React.ReactNode;
  /** Shown instead of the list when there are no models. */
  empty?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const search = React.useRef<HTMLInputElement>(null);

  const byId = React.useMemo(() => new Map((catalog ?? []).map((e) => [e.id, e])), [catalog]);
  const rows = React.useMemo(() => models.map((m) => toRow(m, byId.get(m.id))), [models, byId]);
  const current = value ? (rows.find((r) => r.id === value) ?? toRow({ id: value }, byId.get(value))) : null;

  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => q.split(/\s+/).every((w) => r.haystack.includes(w))) : rows;
  const groups = React.useMemo(() => {
    const out = new Map<string, Row[]>();
    for (const r of shown) {
      const k = r.vendor ?? '';
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    return [...out];
  }, [shown]);
  const searchable = rows.length > SEARCH_FROM;

  // Radix focuses the menu on open; move focus to the search field right after.
  React.useEffect(() => {
    if (!open || !searchable) return;
    const id = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, searchable]);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          title={value ?? undefined}
          className="flex h-7 max-w-72 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <Cpu className="size-3.5 shrink-0" />
          <span className="truncate">{current?.name ?? 'Modell'}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[min(28rem,calc(100vw-2rem))] p-0"
        onKeyDown={(e) => {
          // Typing anywhere in the menu goes to the search field (instead of Radix's typeahead).
          if (!searchable || e.target === search.current || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key.length === 1) {
            e.preventDefault();
            setQuery((v) => v + e.key);
            search.current?.focus();
          } else if (e.key === 'Backspace') {
            e.preventDefault();
            setQuery((v) => v.slice(0, -1));
            search.current?.focus();
          }
        }}
      >
        <div className="flex items-baseline justify-between gap-2 px-3 pt-2 pb-1">
          <DropdownMenuLabel className="p-0">{title}</DropdownMenuLabel>
          {rows.length > 0 && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {q ? `${shown.length} von ${rows.length}` : `${rows.length} Modell${rows.length === 1 ? '' : 'e'}`}
            </span>
          )}
        </div>
        {searchable && (
          <div className="px-2 pb-1.5">
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (shown[0]) pick(shown[0].id);
                  } else if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(e.key)) {
                    e.stopPropagation();
                  }
                }}
                placeholder="Modell suchen…"
                className="h-7 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
              />
            </div>
          </div>
        )}
        <div className="max-h-[min(26rem,60vh)] overflow-y-auto px-1 pb-1">
          {rows.length === 0
            ? empty
            : shown.length === 0 && <div className="px-2 py-3 text-center text-xs text-muted-foreground">Kein Modell passt zu „{query}“.</div>}
          {groups.map(([vendor, list]) => (
            <div key={vendor || '_'} role="group" aria-label={vendor || undefined}>
              {vendor && groups.length > 1 && (
                <div className="px-2 pt-2 pb-0.5 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{vendor}</div>
              )}
              {list.map((r) => (
                <DropdownMenuItem key={r.id} onSelect={() => pick(r.id)} className="items-start gap-2 py-1.5">
                  <Check className={cn('mt-0.5', r.id === value ? 'opacity-100' : 'opacity-0')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      <span className="text-[13px] leading-snug font-medium break-words">{r.name}</span>
                      {r.tags.map((t) => (
                        <span key={t} className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="font-mono text-[10.5px] leading-snug break-all text-muted-foreground">{r.id}</div>
                    {(r.entry?.pricing || r.entry?.contextLength) && (
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] leading-snug text-muted-foreground">
                        {r.entry.pricing && <span>{formatPricing(r.entry.pricing)}</span>}
                        {r.entry.contextLength && <span>{formatTokens(r.entry.contextLength)} Kontext</span>}
                      </div>
                    )}
                  </div>
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </div>
        {footer && (
          <>
            <DropdownMenuSeparator className="my-0" />
            <div className="p-1">{footer}</div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
