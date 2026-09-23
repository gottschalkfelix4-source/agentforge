// Phase 6 – installed agent CLIs: versions, install/update, login terminals, chat policy.
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ArrowUpCircle, Download, LogIn, MessageSquare, RefreshCw, SquareTerminal } from 'lucide-react';
import type { AgentManifest, AgentToolStatus, CreateTerminalRequest, TerminalInfo } from '@vibe/shared';
import { api } from '@/lib/api';
import { qk, useAgents, useProjects } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { controlSocket } from '@/lib/ws';
import { cn, errorMessage } from '@/lib/utils';
import { useTerminalStore } from '@/features/terminal/store';
import { ChatSettings } from '@/features/settings/ChatSettings';
import { SectionHeader } from '@/features/settings/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { toolsApi, toolsKeys, useLatestTools, useProjectTools } from './api';

const PROJECT_KEY = 'vibe-tools-project';

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

export function AgentsTab() {
  const agents = useAgents();
  const projects = useProjects();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [projectId, setProjectId] = React.useState<string | null>(readStoredProject);
  const [busy, setBusy] = React.useState<string | null>(null);

  const running = React.useMemo(
    () => (projects.data ?? []).filter((p) => !p.archived && p.workspace?.status === 'running'),
    [projects.data],
  );
  const selected = running.find((p) => p.id === projectId) ?? null;

  // Fall back to the first running workspace.
  React.useEffect(() => {
    if (projects.data && !selected && running[0]) setProjectId(running[0].id);
  }, [projects.data, selected, running]);

  React.useEffect(() => {
    if (!selected) return;
    try {
      localStorage.setItem(PROJECT_KEY, selected.id);
    } catch {
      /* ignore */
    }
  }, [selected]);

  const latest = useLatestTools();
  const installed = useProjectTools(selected?.id ?? null);

  // Refresh installed versions when a terminal of this workspace exits (e.g. an update finished).
  React.useEffect(() => {
    if (!selected) return;
    const ch = `project:${selected.id}` as const;
    const unsub = controlSocket.subscribe(ch);
    const off = controlSocket.onEvent((ev) => {
      if (ev.type === 'term.exit' && ev.projectId === selected.id) void qc.invalidateQueries({ queryKey: toolsKeys.project(selected.id) });
    });
    return () => {
      off();
      unsub();
    };
  }, [selected, qc]);

  const status = new Map<string, AgentToolStatus>();
  for (const t of latest.data ?? []) status.set(t.agentId, t);
  for (const t of installed.data ?? []) status.set(t.agentId, t);

  /** Opens the project with the new terminal focused. */
  const openTerminal = (pid: string, term: TerminalInfo, origin?: CreateTerminalRequest) => {
    const ts = useTerminalStore.getState();
    ts.setActive(pid, term.id);
    if (origin) ts.setOrigin(term.id, origin);
    useUi.getState().setTerminalVisible(true);
    void qc.invalidateQueries({ queryKey: qk.terminals(pid) });
    navigate(`/p/${pid}`);
  };

  const install = async (m: AgentManifest) => {
    if (!selected) return;
    setBusy(`install:${m.id}`);
    try {
      const size = useTerminalStore.getState().lastSize ?? undefined;
      const term = await toolsApi.install(selected.id, m.id, size);
      toast.success(`${m.label} wird in „${selected.name}“ installiert`, {
        description: 'Die Installation landet im gemeinsamen Tool-Volume und gilt für alle Workspaces.',
      });
      openTerminal(selected.id, term);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const login = async (m: AgentManifest) => {
    if (!selected) return;
    setBusy(`login:${m.id}`);
    try {
      const size = useTerminalStore.getState().lastSize ?? {};
      const req: CreateTerminalRequest = { kind: 'agent', agentId: m.id, mode: 'login', ...size };
      const term = await api.createTerminal(selected.id, req);
      openTerminal(selected.id, term, req);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-8">
      <div>
        <SectionHeader
          title="Agents"
          description="Installierte Agent-CLIs, Updates und Anmeldung. Updates landen im gemeinsamen Tool-Volume (/opt/vibe-tools) und gelten für alle Workspaces."
          action={
            <Button
              variant="ghost"
              size="sm"
              disabled={!selected || installed.isFetching}
              onClick={() => selected && void qc.invalidateQueries({ queryKey: toolsKeys.project(selected.id) })}
            >
              <RefreshCw className={cn('size-3.5', installed.isFetching && 'animate-spin')} /> Neu prüfen
            </Button>
          }
        />

        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Workspace:</span>
          {projects.isPending ? (
            <Skeleton className="h-8 w-56" />
          ) : running.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              Kein laufender Workspace – starte ein Projekt, um installierte Versionen zu sehen und Agents zu aktualisieren.
            </span>
          ) : (
            <Select className="w-64" value={selected?.id ?? ''} onChange={(e) => setProjectId(e.target.value)}>
              {running.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          {installed.isError && <span className="text-xs text-destructive">{errorMessage(installed.error)}</span>}
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Nutzung</th>
                <th className="px-3 py-2 font-medium">Installiert</th>
                <th className="px-3 py-2 font-medium">Aktuell</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.isPending
                ? [0, 1, 2].map((i) => (
                    <tr key={i} className="border-t border-border">
                      <td colSpan={5} className="px-4 py-2">
                        <Skeleton className="h-6" />
                      </td>
                    </tr>
                  ))
                : (agents.data ?? []).map((m) => (
                    <AgentRow
                      key={m.id}
                      manifest={m}
                      status={status.get(m.id)}
                      loadingInstalled={!!selected && installed.isPending}
                      loadingLatest={latest.isPending}
                      hasWorkspace={!!selected}
                      busy={busy}
                      onInstall={() => void install(m)}
                      onLogin={() => void login(m)}
                    />
                  ))}
            </tbody>
          </table>
        </div>
      </div>

      <ChatSettings />
    </div>
  );
}

function AgentRow({
  manifest: m,
  status,
  loadingInstalled,
  loadingLatest,
  hasWorkspace,
  busy,
  onInstall,
  onLogin,
}: {
  manifest: AgentManifest;
  status: AgentToolStatus | undefined;
  loadingInstalled: boolean;
  loadingLatest: boolean;
  hasWorkspace: boolean;
  busy: string | null;
  onInstall: () => void;
  onLogin: () => void;
}) {
  const installable = !!(m.npmPackage || m.installCommand);
  const isInstalled = !!status?.installed;
  const update = !!status?.updateAvailable;
  const noWorkspace = 'Zuerst einen laufenden Workspace wählen';

  return (
    <tr className="border-t border-border">
      <td className="px-4 py-2.5">
        <div className="font-medium">{m.label}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{m.npmPackage ?? m.pypiPackage ?? m.bin}</div>
      </td>
      <td className="px-3 py-2.5">
        {m.structured ? (
          <Badge variant="brand">
            <MessageSquare className="size-3" /> Chat + Terminal
          </Badge>
        ) : (
          <Badge variant="outline">
            <SquareTerminal className="size-3" /> Terminal
          </Badge>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs">
        {!hasWorkspace ? (
          <span className="text-muted-foreground">–</span>
        ) : loadingInstalled ? (
          <Skeleton className="h-4 w-16" />
        ) : isInstalled ? (
          <span className={cn(update && 'text-warning')}>{status!.installed}</span>
        ) : (
          <span className="text-muted-foreground">nicht installiert</span>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs">
        {loadingLatest ? <Skeleton className="h-4 w-16" /> : (status?.latest ?? <span className="text-muted-foreground">–</span>)}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex justify-end gap-1">
          {installable && (
            <Tooltip content={hasWorkspace ? `${isInstalled ? 'Auf neueste Version aktualisieren' : 'Installieren'} (Terminal öffnet sich)` : noWorkspace}>
              <span>
                <Button
                  size="sm"
                  variant={update || (!isInstalled && hasWorkspace && !loadingInstalled) ? 'brand' : 'ghost'}
                  disabled={!hasWorkspace || busy !== null}
                  onClick={onInstall}
                >
                  {isInstalled ? <ArrowUpCircle className="size-3.5" /> : <Download className="size-3.5" />}
                  {!isInstalled ? 'Installieren' : update ? 'Aktualisieren' : 'Neu installieren'}
                </Button>
              </span>
            </Tooltip>
          )}
          {m.loginCommand && (
            <Tooltip content={hasWorkspace ? `Öffnet „${m.loginCommand.join(' ')}“ im Terminal` : noWorkspace}>
              <span>
                <Button size="sm" variant="outline" disabled={!hasWorkspace || busy !== null || (hasWorkspace && !loadingInstalled && !isInstalled)} onClick={onLogin}>
                  <LogIn className="size-3.5" /> Anmelden
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
      </td>
    </tr>
  );
}
