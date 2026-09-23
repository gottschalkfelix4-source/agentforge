import * as React from 'react';
import { useParams } from 'react-router';
import {
  AlertTriangle,
  Loader2,
  MoreHorizontal,
  Play,
  Power,
  RotateCw,
  Hammer,
  Trash2,
  GitBranch,
  PanelBottom,
  PanelRight,
} from 'lucide-react';
import type { WorkspaceAction, WorkspaceStatus } from '@vibe/shared';
import { useProject, useWorkspaceAction } from '@/lib/queries';
import { useLive, useUi } from '@/lib/store';
import { errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useChannel } from './live-sync';
import { isBusy, statusOf, STATUS_LABEL, WorkspaceStatusBadge } from './status';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import { ProjectBody } from './ProjectBody';
import { ViewSwitcher } from './ViewSwitcher';

export function ProjectView() {
  const { projectId = '' } = useParams();
  return <ProjectViewInner key={projectId} projectId={projectId} />;
}

function ProjectViewInner({ projectId }: { projectId: string }) {
  useChannel(projectId ? `project:${projectId}` : null);
  const project = useProject(projectId);
  const action = useWorkspaceAction(projectId);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [recreateOpen, setRecreateOpen] = React.useState(false);
  const terminalVisible = useUi((s) => s.terminalVisible);
  const toggleTerminal = useUi((s) => s.toggleTerminal);
  const projectView = useUi((s) => s.projectView);
  const rightPanel = useUi((s) => s.rightPanel);
  const setRightPanel = useUi((s) => s.setRightPanel);

  if (project.isPending) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 items-center gap-3 border-b border-border px-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-16" />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  if (project.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="size-6 text-destructive" />
        Projekt konnte nicht geladen werden: {errorMessage(project.error)}
      </div>
    );
  }

  const p = project.data;
  const status: WorkspaceStatus = statusOf(p.workspace);
  const running = status === 'running';
  const busy = isBusy(status) || action.isPending;
  const run = (a: WorkspaceAction) => action.mutate(a);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="truncate text-[15px] font-semibold">{p.name}</h1>
        <WorkspaceStatusBadge status={status} />
        <ViewSwitcher />
        {p.gitUrl && (
          <Tooltip content={p.gitUrl}>
            <span className="hidden items-center gap-1 truncate text-xs text-muted-foreground md:flex">
              <GitBranch className="size-3.5" />
              {p.defaultBranch ?? 'git'}
            </span>
          </Tooltip>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {running && (projectView === 'agent' || projectView === 'code') && (
            <Tooltip content={rightPanel ? 'Seitenpanel ausblenden' : 'Vorschau & Git einblenden'}>
              <Button
                variant={rightPanel ? 'secondary' : 'ghost'}
                size="icon-sm"
                onClick={() => setRightPanel(rightPanel ? null : 'preview')}
              >
                <PanelRight />
              </Button>
            </Tooltip>
          )}
          {running && projectView === 'code' && (
            <Tooltip content="Terminal ein-/ausblenden (Strg+`)">
              <Button variant={terminalVisible ? 'secondary' : 'ghost'} size="icon-sm" onClick={toggleTerminal}>
                <PanelBottom />
              </Button>
            </Tooltip>
          )}
          {running ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run('restart')}>
                <RotateCw className={action.isPending && action.variables === 'restart' ? 'animate-spin' : ''} />
                Neu starten
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => run('stop')}>
                <Power /> Stoppen
              </Button>
            </>
          ) : (
            <Button variant="brand" size="sm" disabled={busy} onClick={() => run('start')}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              Starten
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Weitere Aktionen">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy} onSelect={() => setRecreateOpen(true)}>
                <Hammer /> Neu erstellen
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
                <Trash2 /> Löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <ProjectBody
          projectId={projectId}
          running={running}
          workspaceFallback={
            <WorkspaceEmptyState
              projectId={projectId}
              status={status}
              message={p.workspace?.statusMessage ?? null}
              busy={busy}
              onStart={() => run('start')}
            />
          }
        />
      </div>

      <DeleteProjectDialog project={p} open={deleteOpen} onOpenChange={setDeleteOpen} />
      <ConfirmDialog
        open={recreateOpen}
        onOpenChange={setRecreateOpen}
        title="Workspace neu erstellen?"
        description="Der Container wird entfernt und aus dem aktuellen Image neu erstellt. Projektdateien bleiben erhalten, laufende Prozesse werden beendet."
        confirmLabel="Neu erstellen"
        onConfirm={() => action.mutateAsync('recreate')}
      />
    </div>
  );
}

function WorkspaceEmptyState({
  projectId,
  status,
  message,
  busy,
  onStart,
}: {
  projectId: string;
  status: WorkspaceStatus;
  message: string | null;
  busy: boolean;
  onStart: () => void;
}) {
  const pull = useLive((s) => s.pullProgress[projectId]);
  const starting = isBusy(status);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div
          className={
            'flex size-14 items-center justify-center rounded-2xl border border-border bg-panel ' +
            (status === 'error' ? 'text-destructive' : 'text-muted-foreground')
          }
        >
          {starting ? (
            <Loader2 className="size-6 animate-spin text-warning" />
          ) : status === 'error' ? (
            <AlertTriangle className="size-6" />
          ) : (
            <Power className="size-6" />
          )}
        </div>
        <div>
          <h2 className="text-base font-semibold">
            {starting
              ? `Workspace ${status === 'creating' ? 'wird erstellt' : 'startet'}…`
              : status === 'error'
                ? 'Workspace-Fehler'
                : status === 'none'
                  ? 'Noch kein Workspace'
                  : 'Workspace ist gestoppt'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {message ??
              (starting
                ? 'Einen Moment – der Container wird vorbereitet.'
                : 'Starte den Workspace, um Dateien, Terminals und Agents zu nutzen.')}
          </p>
        </div>
        {pull && starting && (
          <pre className="w-full max-w-md truncate rounded-lg border border-border bg-panel px-3 py-2 text-left font-mono text-xs text-muted-foreground">
            {pull}
          </pre>
        )}
        {!starting && (
          <Button variant="brand" onClick={onStart} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Play />}
            {status === 'error' ? 'Erneut starten' : 'Workspace starten'}
          </Button>
        )}
        <span className="text-xs text-muted-foreground/70">Status: {STATUS_LABEL[status]}</span>
      </div>
    </div>
  );
}
