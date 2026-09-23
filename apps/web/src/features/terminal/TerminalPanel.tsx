import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, Maximize2, Minimize2, Plus, SquareTerminal, X } from 'lucide-react';
import type { CreateTerminalRequest, TerminalInfo } from '@vibe/shared';
import { api } from '@/lib/api';
import { qk, useAgents, useTerminals } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { AgentMenu } from './AgentMenu';
import { PortsIndicator } from './PortsIndicator';
import { TerminalView } from './TerminalView';
import { useTerminalStore } from './store';

function sortTerms(list: TerminalInfo[]) {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function TerminalPanel({ projectId, running }: { projectId: string; running: boolean }) {
  const qc = useQueryClient();
  const terminals = useTerminals(projectId, running);
  const agents = useAgents();
  const maximized = useUi((s) => s.terminalMaximized);
  const toggleMax = useUi((s) => s.toggleTerminalMaximized);
  const setVisible = useUi((s) => s.setTerminalVisible);
  const activeId = useTerminalStore((s) => s.active[projectId]);
  const setActive = useTerminalStore((s) => s.setActive);

  const list = React.useMemo(() => sortTerms(terminals.data ?? []), [terminals.data]);
  const current = list.find((t) => t.id === activeId) ?? list[list.length - 1] ?? null;

  const getList = React.useCallback(
    () => qc.getQueryData<TerminalInfo[]>(qk.terminals(projectId)) ?? [],
    [qc, projectId],
  );

  const create = useMutation({
    mutationFn: (req: CreateTerminalRequest) => {
      const size = useTerminalStore.getState().lastSize;
      return api.createTerminal(projectId, size ? { ...req, cols: size.cols, rows: size.rows } : req);
    },
    onSuccess: (info, req) => {
      qc.setQueryData<TerminalInfo[]>(qk.terminals(projectId), (old) =>
        old?.some((t) => t.id === info.id) ? old : [...(old ?? []), info],
      );
      useTerminalStore.getState().setOrigin(info.id, req);
      setActive(projectId, info.id);
      useUi.getState().setTerminalVisible(true);
    },
  });

  const remove = useMutation({
    mutationFn: (termId: string) => api.deleteTerminal(projectId, termId),
    onMutate: (termId) => {
      const before = getList();
      const idx = before.findIndex((t) => t.id === termId);
      const next = before.filter((t) => t.id !== termId);
      qc.setQueryData<TerminalInfo[]>(qk.terminals(projectId), next);
      if (useTerminalStore.getState().active[projectId] === termId) {
        const sorted = sortTerms(next);
        setActive(projectId, sorted[Math.max(0, idx - 1)]?.id);
      }
      return { before };
    },
    onError: (_err, _termId, ctx) => {
      if (ctx?.before) qc.setQueryData(qk.terminals(projectId), ctx.before);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.terminals(projectId) }),
  });

  const restart = (term: TerminalInfo) => {
    const req = useTerminalStore.getState().origin[term.id] ?? { kind: 'shell' as const };
    create.mutate(req, { onSuccess: () => remove.mutate(term.id) });
  };

  const labelFor = (t: TerminalInfo) => {
    if (t.title) return t.title;
    const agent = agents.data?.find((a) => a.bin === t.command);
    return agent?.label ?? t.command ?? 'Terminal';
  };
  const isAgent = (t: TerminalInfo) => !!agents.data?.some((a) => a.bin === t.command);

  return (
    <div className="flex h-full min-h-0 flex-col bg-terminal">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-sidebar pr-1.5 pl-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {list.map((t) => {
            const active = t.id === current?.id;
            const Icon = isAgent(t) ? Bot : SquareTerminal;
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setActive(projectId, t.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    remove.mutate(t.id);
                  }
                }}
                title={[t.command, ...t.args].join(' ')}
                className={cn(
                  'group flex h-7 max-w-52 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-xs text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground',
                  active && 'bg-accent text-foreground',
                )}
              >
                <Icon className={cn('size-3.5 shrink-0', isAgent(t) && !t.exited && 'text-brand')} />
                <span className={cn('truncate', t.exited && 'line-through opacity-60')}>{labelFor(t)}</span>
                <button
                  type="button"
                  aria-label="Terminal schließen"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove.mutate(t.id);
                  }}
                  className={cn(
                    'flex size-4 cursor-pointer items-center justify-center rounded hover:bg-background/60',
                    !active && 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <Tooltip content="Neues Terminal">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
              disabled={!running || create.isPending}
              onClick={() => create.mutate({ kind: 'shell' })}
            >
              <Plus className="size-3.5" /> Terminal
            </Button>
          </Tooltip>
        </div>
        <PortsIndicator projectId={projectId} enabled={running} />
        <AgentMenu disabled={!running || create.isPending} busy={create.isPending} onLaunch={(req) => create.mutate(req)} />
        <Tooltip content={maximized ? 'Wiederherstellen' : 'Maximieren'}>
          <Button variant="ghost" size="icon-sm" onClick={toggleMax}>
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
        </Tooltip>
        <Tooltip content="Panel ausblenden (Strg+`)">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              if (maximized) toggleMax();
              setVisible(false);
            }}
          >
            <ChevronDown />
          </Button>
        </Tooltip>
      </div>

      <div className="relative min-h-0 flex-1">
        {terminals.isPending && running ? (
          <div className="grid gap-2 p-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : list.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <SquareTerminal className="size-7 opacity-40" />
            <p>Kein Terminal geöffnet.</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!running} onClick={() => create.mutate({ kind: 'shell' })}>
                <Plus /> Terminal öffnen
              </Button>
              <AgentMenu disabled={!running} onLaunch={(req) => create.mutate(req)} />
            </div>
          </div>
        ) : (
          list.map((t) => (
            <TerminalView
              key={t.id}
              projectId={projectId}
              termId={t.id}
              visible={t.id === current?.id}
              isAlive={() => getList().some((x) => x.id === t.id && !x.exited)}
              knownExit={() => {
                const x = getList().find((y) => y.id === t.id);
                return { exited: !!x?.exited, exitCode: x?.exitCode ?? null };
              }}
              onExit={() => void qc.invalidateQueries({ queryKey: qk.terminals(projectId) })}
              onRestart={() => restart(t)}
            />
          ))
        )}
      </div>
    </div>
  );
}
