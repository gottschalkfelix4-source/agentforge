import * as React from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Flag, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Milestone, MilestoneInput, Task } from '@vibe/shared';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/label';
import { COLUMN_LABEL, pmApi, sortByRank, useMilestones, usePmLive, usePmMutation, useTasks } from './api';
import { EmptyHint, formatDate, LabelChip, MarkdownField, RunBadge, todayIso } from './common';
import { TaskDialog } from './TaskDialog';

function MilestoneDialog({
  projectId,
  milestone,
  open,
  onOpenChange,
}: {
  projectId: string;
  milestone: Milestone | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [dueOn, setDueOn] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setTitle(milestone?.title ?? '');
    setDescription(milestone?.description ?? '');
    setDueOn(milestone?.dueOn ?? '');
    setConfirmDelete(false);
  }, [open, milestone]);

  const save = usePmMutation(projectId, (v: MilestoneInput) => (milestone ? pmApi.updateMilestone(milestone.id, v) : pmApi.createMilestone(projectId, v)));
  const remove = usePmMutation(projectId, () => pmApi.deleteMilestone(milestone!.id));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    save.mutate(
      { title: title.trim(), description, dueOn: dueOn || null },
      { onSuccess: () => (onOpenChange(false), toast.success(milestone ? 'Meilenstein gespeichert' : 'Meilenstein angelegt')) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{milestone ? 'Meilenstein bearbeiten' : 'Neuer Meilenstein'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Titel" htmlFor="ms-title">
            <Input id="ms-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="z. B. v1.0 – Beta" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fällig am" htmlFor="ms-due">
              <Input id="ms-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} className="dark:[color-scheme:dark]" />
            </Field>
            <Field label="Status">
              {/* Read-only: the agent opens/closes milestones (board tools), never the user. */}
              <div
                title="Den Status setzt der Agent"
                className="flex h-8 items-center rounded-lg border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground"
              >
                {milestone?.state === 'closed' ? 'Geschlossen' : 'Offen'}
              </div>
            </Field>
          </div>
          <Field label="Beschreibung">
            <MarkdownField value={description} onChange={setDescription} projectId={projectId} minHeight="min-h-32" placeholder="Ziele, Umfang, Notizen…" />
          </Field>
          <DialogFooter className="items-center">
            {milestone &&
              (confirmDelete ? (
                <Button
                  variant="destructive"
                  className="mr-auto"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(undefined, { onSuccess: () => onOpenChange(false) })}
                >
                  Wirklich löschen (Aufgaben bleiben erhalten)
                </Button>
              ) : (
                <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Löschen
                </Button>
              ))}
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!title.trim() || save.isPending}>
              Speichern
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TaskLine({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const done = task.column === 'done';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
    >
      {done ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <CircleDot className="size-4 shrink-0 text-muted-foreground" />}
      <span className={cn('min-w-0 flex-1 truncate', done && 'text-muted-foreground line-through')}>{task.title}</span>
      {task.labels.slice(0, 3).map((l) => (
        <LabelChip key={l.id} label={l} className="hidden sm:inline-flex" />
      ))}
      {task.latestRun && task.latestRun.status !== 'cancelled' && <RunBadge status={task.latestRun.status} />}
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{COLUMN_LABEL[task.column]}</span>
    </button>
  );
}

function ProgressBar({ done, total, overdue }: { done: number; total: number; overdue: boolean }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', pct === 100 ? 'bg-success' : overdue ? 'bg-destructive' : 'bg-brand')} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {done}/{total} · {pct}%
      </span>
    </div>
  );
}

function MilestoneCard({
  milestone,
  tasks,
  onEdit,
  onOpenTask,
}: {
  milestone: Milestone;
  tasks: Task[];
  onEdit: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(milestone.state === 'open');
  const closed = milestone.state === 'closed';
  const overdue = !closed && !!milestone.dueOn && milestone.dueOn < todayIso() && milestone.progress.done < milestone.progress.total;
  const overdueNoTasks = !closed && !!milestone.dueOn && milestone.dueOn < todayIso() && milestone.progress.total === 0;
  return (
    <div className="relative pl-8">
      <span
        className={cn(
          'absolute top-4 left-[7px] size-3.5 rounded-full border-2 bg-background',
          closed ? 'border-success bg-success' : overdue || overdueNoTasks ? 'border-destructive' : 'border-brand',
        )}
      />
      <div className={cn('rounded-xl border bg-panel', overdue ? 'border-destructive/40' : 'border-border', closed && 'opacity-75')}>
        <div className="flex items-start gap-2 p-3">
          <button type="button" className="mt-0.5 cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setExpanded(!expanded)} aria-label="Aufklappen">
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
          <div className="grid min-w-0 flex-1 gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{milestone.title}</span>
              {closed && <span className="rounded-md border border-success/30 bg-success/10 px-1.5 text-[11px] text-success">Geschlossen</span>}
              {milestone.ghNumber && <span className="text-xs text-muted-foreground">GitHub #{milestone.ghNumber}</span>}
              <span className={cn('ml-auto inline-flex items-center gap-1 text-xs', overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                {overdue && <AlertTriangle className="size-3.5" />}
                <CalendarDays className="size-3.5" />
                {milestone.dueOn ? `${overdue ? 'Überfällig seit' : 'Fällig am'} ${formatDate(milestone.dueOn)}` : 'Kein Termin'}
              </span>
            </div>
            <ProgressBar done={milestone.progress.done} total={milestone.progress.total} overdue={overdue} />
            {milestone.description && expanded && <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">{milestone.description}</p>}
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label="Bearbeiten">
            <Pencil />
          </Button>
        </div>
        {expanded && (
          <div className="border-t border-border p-1.5">
            {tasks.map((t) => (
              <TaskLine key={t.id} task={t} onOpen={() => onOpenTask(t.id)} />
            ))}
            {!tasks.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">Keine Aufgaben zugeordnet – im Board unter „Meilenstein“ zuweisen.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

const colOrder = { in_progress: 0, review: 1, todo: 2, backlog: 3, done: 4 } as const;
const byStatus = (a: Task, b: Task) => colOrder[a.column] - colOrder[b.column] || sortByRank(a, b);

export function RoadmapView({ projectId }: { projectId: string }) {
  usePmLive(projectId);
  const milestones = useMilestones(projectId);
  const tasks = useTasks(projectId);
  const [edit, setEdit] = React.useState<{ open: boolean; milestone: Milestone | null }>({ open: false, milestone: null });
  const [openTask, setOpenTask] = React.useState<string | null>(null);
  const [showClosed, setShowClosed] = React.useState(false);
  const closeTask = React.useCallback(() => setOpenTask(null), []);

  const grouped = React.useMemo(() => {
    const m = new Map<string | null, Task[]>();
    for (const t of tasks.data ?? []) {
      const k = t.milestoneId ?? null;
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    for (const list of m.values()) list.sort(byStatus);
    return m;
  }, [tasks.data]);

  const list = (milestones.data ?? []).filter((m) => showClosed || m.state === 'open');
  const closedCount = (milestones.data ?? []).filter((m) => m.state === 'closed').length;
  const unassigned = grouped.get(null) ?? [];

  if (milestones.isError) return <EmptyHint>{errorMessage(milestones.error)}</EmptyHint>;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto grid max-w-4xl gap-4 px-6 py-6">
        <div className="flex items-center gap-2">
          <Flag className="size-5 text-brand" />
          <h2 className="text-lg font-semibold">Roadmap</h2>
          <div className="ml-auto flex items-center gap-2">
            {closedCount > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowClosed(!showClosed)}>
                {showClosed ? 'Geschlossene ausblenden' : `Geschlossene anzeigen (${closedCount})`}
              </Button>
            )}
            <Button size="sm" variant="brand" onClick={() => setEdit({ open: true, milestone: null })}>
              <Plus /> Meilenstein
            </Button>
          </div>
        </div>

        {milestones.isSuccess && !milestones.data.length && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Noch keine Meilensteine. Lege einen an, um Aufgaben zu bündeln und den Fortschritt zu verfolgen.
          </div>
        )}

        <div className="relative grid gap-3">
          {list.length > 0 && <span className="absolute top-4 bottom-4 left-[13px] w-px bg-border" />}
          {list.map((m) => (
            <MilestoneCard
              key={m.id}
              milestone={m}
              tasks={grouped.get(m.id) ?? []}
              onEdit={() => setEdit({ open: true, milestone: m })}
              onOpenTask={setOpenTask}
            />
          ))}
        </div>

        <div className="rounded-xl border border-border bg-panel">
          <div className="flex items-center gap-2 p-3 text-sm font-semibold">
            Ohne Meilenstein <span className="text-xs font-normal text-muted-foreground">{unassigned.length} Aufgaben</span>
          </div>
          {unassigned.length > 0 && (
            <div className="border-t border-border p-1.5">
              {unassigned.map((t) => (
                <TaskLine key={t.id} task={t} onOpen={() => setOpenTask(t.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
      <MilestoneDialog projectId={projectId} milestone={edit.milestone} open={edit.open} onOpenChange={(o) => setEdit((s) => ({ ...s, open: o }))} />
      <TaskDialog projectId={projectId} taskId={openTask} onClose={closeTask} />
    </div>
  );
}
