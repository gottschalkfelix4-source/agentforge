import * as React from 'react';
import { Link } from 'react-router';
import { Github, Loader2, Lock, Search } from 'lucide-react';
import type { GhRepo } from '@vibe/shared';
import { cn, errorMessage } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useDebounced, useGitHubRepos, useGitHubStatus } from './api';

function relTime(iso: string): string {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '';
  if (d < 3600) return `vor ${Math.max(1, Math.round(d / 60))} Min.`;
  if (d < 86400) return `vor ${Math.round(d / 3600)} Std.`;
  if (d < 86400 * 30) return `vor ${Math.round(d / 86400)} Tagen`;
  return new Date(iso).toLocaleDateString('de-DE');
}

/** Searchable list of the connected account's repositories. */
export function RepoPicker({
  selected,
  onSelect,
  className,
}: {
  selected: GhRepo | null;
  onSelect: (repo: GhRepo) => void;
  className?: string;
}) {
  const status = useGitHubStatus();
  const [q, setQ] = React.useState('');
  const query = useDebounced(q.trim(), 300);
  const connected = !!status.data?.connected;
  const repos = useGitHubRepos(query, connected);

  if (status.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        <Github className="size-5 opacity-60" />
        GitHub ist nicht verbunden.
        <Link to="/settings/github" className="text-brand hover:underline">
          In den Einstellungen verbinden
        </Link>
      </div>
    );
  }

  return (
    <div className={cn('grid gap-2', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" placeholder="Repositories durchsuchen oder owner/name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="max-h-72 min-h-32 overflow-y-auto rounded-lg border border-border">
        {repos.isPending ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : repos.isError ? (
          <p className="p-3 text-sm text-destructive">{errorMessage(repos.error)}</p>
        ) : repos.data.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">Keine Repositories gefunden.</p>
        ) : (
          repos.data.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r)}
              className={cn(
                'flex w-full items-start gap-2 border-b border-border/50 px-3 py-2 text-left last:border-b-0 hover:bg-accent',
                selected?.id === r.id && 'bg-brand/10 hover:bg-brand/15',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="truncate font-medium">{r.fullName}</span>
                  {r.private && <Lock className="size-3 shrink-0 text-muted-foreground" />}
                </div>
                {r.description && <div className="truncate text-xs text-muted-foreground">{r.description}</div>}
              </div>
              <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground">{relTime(r.updatedAt)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
