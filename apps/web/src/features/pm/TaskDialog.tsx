import * as React from 'react';
import { toast } from 'sonner';
import { Bot, Check, ExternalLink, GitBranch, GitPullRequest, MessageSquare, Plus, Tag, Trash2, X } from 'lucide-react';
import type { ApprovalPolicy, Label, Task, TaskRun } from '@vibe/shared';
import { useProfiles } from '@/lib/queries';
import { useNav, useUi } from '@/lib/store';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useChatAgents } from '@/features/chat/api';
import { usePersistentState } from '@/features/chat/util';
import { COLUMN_LABEL, pmApi, useLabels, useMilestones, usePmMutation, useRuns, useTasks } from './api';
import { formatDateTime, LabelChip, MarkdownField, RunBadge } from './common';
import { SubtaskList, SubtaskProgress } from './Subtasks';

const PALETTE = ['e11d48', 'f97316', 'eab308', '22c55e', '14b8a6', '3b82f6', '8b5cf6', 'ec4899', '64748b'];

/** Multi-select for labels incl. creating new ones. */
export function LabelPicker({
  projectId,
  selected,
  onChange,
  trigger,
}: {
  projectId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  trigger?: React.ReactNode;
}) {
  const labels = useLabels(projectId);
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState(PALETTE[5]!);
  const create = usePmMutation(projectId, (v: { name: string; color: string }) => pmApi.createLabel(projectId, v));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    const l = await create.mutateAsync({ name: n, color });
    setName('');
    onChange([...selected, l.id]);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <Tag /> Labels
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Labels</DropdownMenuLabel>
        <div className="max-h-60 overflow-y-auto">
          {(labels.data ?? []).map((l) => (
            <DropdownMenuItem key={l.id} onSelect={(e) => (e.preventDefault(), toggle(l.id))}>
              <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: `#${l.color}` }} />
              <span className="flex-1 truncate">{l.name}</span>
              {selected.includes(l.id) && <Check className="!text-foreground" />}
            </DropdownMenuItem>
          ))}
          {!labels.data?.length && <p className="px-2 py-1 text-xs text-muted-foreground">Noch keine Labels.</p>}
        </div>
        <DropdownMenuSeparator />
        <div className="grid gap-1.5 p-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Neues Label…"
            className="h-7 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center gap-1">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Farbe ${c}`}
                onClick={() => setColor(c)}
                className={cn('size-4 cursor-pointer rounded-full ring-offset-1 ring-offset-popover', color === c && 'ring-2 ring-foreground/60')}
                style={{ backgroundColor: `#${c}` }}
              />
            ))}
            <Button size="icon-xs" variant="secondary" className="ml-auto" disabled={!name.trim() || create.isPending} onClick={() => void submit()} aria-label="Label anlegen">
              <Plus />
            </Button>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentHandoff({ projectId, task }: { projectId: string; task: Task }) {
  const agents = useChatAgents();
  const profiles = useProfiles();
  const [agentId, setAgentId] = usePersistentState<string>('vibe-pm-agent', '');
  const [profilePref, setProfilePref] = usePersistentState<Record<string, string | null>>('vibe-pm-profile', {});
  const [autoPr, setAutoPr] = usePersistentState<boolean>('vibe-pm-autopr', true);
  const [approvalPolicy, setApprovalPolicy] = usePersistentState<ApprovalPolicy>('vibe-pm-approval', 'ask');
  const [error, setError] = React.useState<string | null>(null);
  const agent = agents.data.find((a) => a.id === agentId) ?? agents.data[0];
  const agentProfiles = (profiles.data ?? []).filter((p) => p.agentKind === agent?.id);
  const stored = agent ? profilePref[agent.id] : null;
  const profileId = agentProfiles.some((p) => p.id === stored) ? stored! : null;
  const run = usePmMutation(projectId, () => pmApi.runTask(task.id, { agentId: agent!.id, profileId, autoPr, approvalPolicy }));
  const running = task.latestRun?.status === 'running';

  const start = () => {
    setError(null);
    run.mutate(undefined, {
      onSuccess: () => toast.success('Aufgabe an den Agent übergeben'),
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Bot className="size-4 text-brand" /> An Agent übergeben
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select value={agent?.id ?? ''} onChange={(e) => setAgentId(e.target.value)} disabled={!agents.data.length} aria-label="Agent">
          {agents.data.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
          {!agents.data.length && <option value="">Keine Agents verfügbar</option>}
        </Select>
        <Select
          value={profileId ?? '__default'}
          onChange={(e) => agent && setProfilePref({ ...profilePref, [agent.id]: e.target.value === '__default' ? null : e.target.value })}
          aria-label="Profil"
        >
          <option value="__default">Standard-Profil</option>
          {agentProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      <Select value={approvalPolicy} onChange={(e) => setApprovalPolicy(e.target.value as ApprovalPolicy)} aria-label="Freigaben">
        <option value="ask">Freigaben: Manuell nachfragen</option>
        <option value="edits">Freigaben: Dateiänderungen automatisch</option>
        <option value="all">Freigaben: Alles erlauben</option>
      </Select>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={autoPr} onChange={(e) => setAutoPr(e.target.checked)} />
        Automatisch PR erstellen, wenn der Agent fertig ist
      </label>
      <p className="text-xs text-muted-foreground">
        Der Agent arbeitet in einem eigenen Git-Worktree auf einem neuen Branch – dein Arbeitsverzeichnis bleibt unberührt.
      </p>
      {error && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button variant="brand" size="sm" disabled={!agent || run.isPending || running} onClick={start}>
          <Bot /> {running ? 'Agent arbeitet bereits' : run.isPending ? 'Starte…' : 'Agent starten'}
        </Button>
      </div>
    </div>
  );
}

function RunRow({ projectId, run, onOpenSession }: { projectId: string; run: TaskRun; onOpenSession: (sid: string) => void }) {
  const finish = usePmMutation(projectId, () => pmApi.finishRun(run.id));
  const cancel = usePmMutation(projectId, (remove: boolean) => pmApi.cancelRun(run.id, remove));
  const open = run.status === 'running' || run.status === 'awaiting_review' || run.status === 'failed' || run.status === 'pr_open';
  return (
    <div className="grid gap-1.5 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <RunBadge status={run.status} />
        <span className="font-medium">{run.agentId}</span>
        <span className="text-muted-foreground">{formatDateTime(run.createdAt)}</span>
        {run.prUrl && (
          <a href={run.prUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-brand hover:underline">
            <GitPullRequest className="size-3" /> PR #{run.prNumber}
          </a>
        )}
      </div>
      <div className="flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground" title={run.worktreePath}>
        <GitBranch className="size-3 shrink-0" /> {run.branch}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {run.sessionId && (
          <Button size="sm" variant="outline" onClick={() => onOpenSession(run.sessionId!)}>
            <MessageSquare /> Session öffnen
          </Button>
        )}
        {open && (
          <Button
            size="sm"
            variant="secondary"
            disabled={finish.isPending}
            onClick={() =>
              finish.mutate(undefined, {
                onSuccess: (r) => toast.success(r.prUrl ? `PR #${r.prNumber} ist offen` : 'Änderungen committet – bereit zur Prüfung'),
              })
            }
          >
            <GitPullRequest /> {finish.isPending ? 'Läuft…' : run.status === 'pr_open' ? 'Erneut pushen' : 'Fertigstellen & PR'}
          </Button>
        )}
        {open && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={cancel.isPending}>
                <X /> Abbrechen
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => cancel.mutate(false)}>Abbrechen, Worktree behalten</DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => cancel.mutate(true)}>
                <Trash2 /> Abbrechen und Worktree löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function TaskEditor({ projectId, task, onClose }: { projectId: string; task: Task; onClose: () => void }) {
  const milestones = useMilestones(projectId);
  const runs = useRuns(projectId, task.id);
  const [title, setTitle] = React.useState(task.title);
  const [body, setBody] = React.useState(task.body);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const update = usePmMutation(projectId, (v: Parameters<typeof pmApi.updateTask>[1]) => pmApi.updateTask(task.id, v));
  const remove = usePmMutation(projectId, () => pmApi.deleteTask(task.id));

  // Adopt remote changes unless the user is editing.
  const lastTask = React.useRef(task);
  React.useEffect(() => {
    if (lastTask.current.title === title && task.title !== title) setTitle(task.title);
    if (lastTask.current.body === body && task.body !== body) setBody(task.body);
    lastTask.current = task;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.title, task.body]);

  const dirty = title.trim() !== task.title || body !== task.body;
  const save = () => {
    if (!title.trim()) return toast.error('Titel darf nicht leer sein');
    update.mutate({ title: title.trim(), body }, { onSuccess: () => toast.success('Gespeichert') });
  };
  const openSession = (sid: string) => {
    useNav.getState().setActiveSession(projectId, sid);
    useUi.getState().setProjectView('agent');
    onClose();
  };
  const labelIds = task.labels.map((l) => l.id);

  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-2 pr-6">
        <DialogTitle className="sr-only">Aufgabe bearbeiten</DialogTitle>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="h-9 border-transparent px-1.5 text-base font-semibold hover:border-input"
          aria-label="Titel"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Status">
          {/* Read-only: the status is set by the agent (board tools), never by the user. */}
          <div
            title="Den Status setzt der Agent"
            className="flex h-8 items-center rounded-lg border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground"
          >
            {COLUMN_LABEL[task.column]}
          </div>
        </Field>
        <Field label="Meilenstein">
          <Select value={task.milestoneId ?? ''} onChange={(e) => update.mutate({ milestoneId: e.target.value || null })}>
            <option value="">Kein Meilenstein</option>
            {(milestones.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.state === 'closed' ? ' (geschlossen)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="GitHub" className="col-span-2 sm:col-span-1">
          {task.ghUrl ? (
            <a href={task.ghUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 text-sm text-brand hover:underline">
              Issue #{task.ghIssueNumber} <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <span className="inline-flex h-8 items-center text-sm text-muted-foreground">Kein Issue</span>
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {task.labels.map((l: Label) => (
          <LabelChip key={l.id} label={l} onRemove={() => update.mutate({ labelIds: labelIds.filter((x) => x !== l.id) })} />
        ))}
        <LabelPicker
          projectId={projectId}
          selected={labelIds}
          onChange={(ids) => update.mutate({ labelIds: ids })}
          trigger={
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground">
              <Tag className="size-3" /> Labels bearbeiten
            </Button>
          }
        />
      </div>

      <MarkdownField value={body} onChange={setBody} projectId={projectId} placeholder="Beschreibung, Akzeptanzkriterien, Hinweise für den Agent…" minHeight="min-h-48" />
      <div className="flex items-center justify-end gap-2">
        {dirty && <span className="text-xs text-muted-foreground">Ungespeicherte Änderungen</span>}
        <Button size="sm" disabled={!dirty || update.isPending} onClick={save}>
          Speichern
        </Button>
      </div>

      <div className="grid gap-1.5">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Unteraufgaben
          {task.subtasks.length > 0 && <SubtaskProgress subtasks={task.subtasks} />}
        </div>
        <SubtaskList projectId={projectId} task={task} />
      </div>

      <AgentHandoff projectId={projectId} task={task} />

      {!!runs.data?.length && (
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">Agent-Läufe</div>
          {runs.data.map((r) => (
            <RunRow key={r.id} projectId={projectId} run={r} onOpenSession={openSession} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
        <span>
          Erstellt {formatDateTime(task.createdAt)} · Geändert {formatDateTime(task.updatedAt)}
        </span>
        {confirmDelete ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Nein
            </Button>
            <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
              Wirklich löschen
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Löschen
          </Button>
        )}
      </div>
    </div>
  );
}

/** Task detail dialog; `taskId === null` closes it. */
export function TaskDialog({ projectId, taskId, onClose }: { projectId: string; taskId: string | null; onClose: () => void }) {
  const tasks = useTasks(projectId);
  const task = taskId ? tasks.data?.find((t) => t.id === taskId) : undefined;
  React.useEffect(() => {
    if (taskId && tasks.isSuccess && !task) onClose();
  }, [taskId, task, tasks.isSuccess, onClose]);
  return (
    <Dialog open={!!taskId && !!task} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">{task && <TaskEditor key={task.id} projectId={projectId} task={task} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

