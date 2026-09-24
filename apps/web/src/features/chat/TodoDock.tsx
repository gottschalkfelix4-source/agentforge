// Todo bar above the composer (like Codex / OpenCode): the agent's own todo list (plan / TodoWrite) plus the
// board tasks this chat works on, each with its subtasks.

import * as React from 'react';
import { toast } from 'sonner';
import type { PlanEntry, Task } from '@vibe/shared';
import { ChevronRight, CircleDot, KanbanSquare, Link2, ListChecks, Loader2, Search, X } from 'lucide-react';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { COLUMN_LABEL, pmApi, sortByRank, useSessionTasks, usePmLive, useTasks } from '@/features/pm/api';
import { CheckCircle, SubtaskList } from '@/features/pm/Subtasks';
import { TaskDialog } from '@/features/pm/TaskDialog';
import type { Turn } from './transcript';
import { usePersistentState } from './util';

/** Latest agent todo list: shown while it belongs to the current turn or still has open entries. */
export function currentPlan(turns: Turn[]): PlanEntry[] | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const plan = turns[i]!.plan;
    if (!plan?.length) continue;
    const isLast = i === turns.length - 1;
    return isLast || plan.some((e) => e.status !== 'completed') ? plan : null;
  }
  return null;
}

function PlanRow({ entry }: { entry: PlanEntry }) {
  return (
    <li className="flex items-start gap-2 px-1.5 py-0.5 text-[12.5px]">
      {entry.status === 'in_progress' ? (
        <CircleDot className="mt-[2px] size-3.5 shrink-0 animate-pulse text-brand" />
      ) : (
        <CheckCircle checked={entry.status === 'completed'} className="mt-[3px]" />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 break-words',
          entry.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/40',
          entry.status === 'in_progress' && 'font-medium',
        )}
      >
        {entry.text}
      </span>
    </li>
  );
}

/** Picks an open board task to link to this chat. */
function LinkTaskDialog({
  projectId,
  sessionId,
  linked,
  open,
  onOpenChange,
}: {
  projectId: string;
  sessionId: string;
  linked: string[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const tasks = useTasks(projectId);
  const [q, setQ] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const query = q.trim().toLowerCase();
  const candidates = (tasks.data ?? [])
    .filter((t) => t.column !== 'done' && !linked.includes(t.id))
    .filter((t) => !query || t.title.toLowerCase().includes(query))
    .sort((a, b) => (a.column === b.column ? sortByRank(a, b) : a.column === 'in_progress' ? -1 : b.column === 'in_progress' ? 1 : 0));
  const link = async (t: Task) => {
    setBusy(t.id);
    try {
      await pmApi.linkSessionTask(sessionId, t.id);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0">
        <DialogTitle className="px-4 pt-4 text-sm">Board-Aufgabe mit diesem Chat verknüpfen</DialogTitle>
        <p className="px-4 text-xs text-muted-foreground">Die Aufgabe erscheint samt Unteraufgaben in der Todo-Leiste über dem Eingabefeld.</p>
        <div className="mx-4 mt-1 flex items-center gap-2 rounded-md border border-input px-2">
          <Search className="size-3.5 text-muted-foreground" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Aufgabe suchen…" className="h-8 flex-1 bg-transparent text-sm outline-none" />
        </div>
        <ul className="max-h-80 overflow-y-auto px-2 pb-3">
          {candidates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void link(t)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
              >
                {busy === t.id ? <Loader2 className="size-3.5 animate-spin" /> : <KanbanSquare className="size-3.5 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{COLUMN_LABEL[t.column]}</span>
              </button>
            </li>
          ))}
          {tasks.isSuccess && !candidates.length && <li className="px-2 py-3 text-center text-xs text-muted-foreground">Keine offenen Aufgaben gefunden.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function TaskSection({
  projectId,
  task,
  canUnlink,
  onUnlink,
  onOpen,
}: {
  projectId: string;
  task: Task;
  canUnlink: boolean;
  onUnlink: () => void;
  onOpen: () => void;
}) {
  const done = task.subtasks.filter((s) => s.done).length;
  return (
    <div className="group/task">
      <div className="flex items-center gap-1.5 px-1.5 pt-1 text-[12px]">
        <KanbanSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <button type="button" onClick={onOpen} className="min-w-0 cursor-pointer truncate font-medium hover:underline" title="Aufgabe öffnen">
          {task.title}
        </button>
        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10.5px] text-muted-foreground">{COLUMN_LABEL[task.column]}</span>
        {task.subtasks.length > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {done}/{task.subtasks.length}
          </span>
        )}
        {canUnlink && (
          <button
            type="button"
            onClick={onUnlink}
            aria-label="Aus der Todo-Leiste entfernen"
            title="Aus der Todo-Leiste entfernen (die Aufgabe bleibt auf dem Board)"
            className="ml-auto cursor-pointer text-muted-foreground opacity-0 transition-opacity group-hover/task:opacity-100 hover:text-foreground focus-visible:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="pl-4">
        <SubtaskList projectId={projectId} task={task} compact />
      </div>
    </div>
  );
}

export function TodoDock({ projectId, sessionId, turns }: { projectId: string; sessionId: string; turns: Turn[] }) {
  usePmLive(projectId);
  const tasks = useTasks(projectId);
  const links = useSessionTasks(projectId, sessionId);
  const [open, setOpen] = usePersistentState('vibe-todo-dock-open', true);
  const [linking, setLinking] = React.useState(false);
  const [openTask, setOpenTask] = React.useState<string | null>(null);
  const closeTask = React.useCallback(() => setOpenTask(null), []);
  React.useEffect(() => {
    const onLink = () => setLinking(true);
    todoDockEvents.addEventListener('link', onLink);
    return () => todoDockEvents.removeEventListener('link', onLink);
  }, []);

  const plan = React.useMemo(() => currentPlan(turns), [turns]);
  const linkedIds = links.data?.taskIds ?? [];
  const byId = new Map((tasks.data ?? []).map((t) => [t.id, t]));
  // Finished tasks drop out; the task the session was started for stays.
  const boardTasks = linkedIds
    .map((id) => byId.get(id))
    .filter((t): t is Task => !!t && (t.column !== 'done' || t.id === links.data?.runTaskId));

  const total = (plan?.length ?? 0) + boardTasks.reduce((n, t) => n + t.subtasks.length, 0);
  const done =
    (plan?.filter((e) => e.status === 'completed').length ?? 0) + boardTasks.reduce((n, t) => n + t.subtasks.filter((s) => s.done).length, 0);
  const current =
    plan?.find((e) => e.status === 'in_progress')?.text ??
    boardTasks.flatMap((t) => t.subtasks).find((s) => !s.done)?.title ??
    plan?.find((e) => e.status === 'pending')?.text ??
    null;

  const unlink = (tid: string) => void pmApi.unlinkSessionTask(sessionId, tid).catch((err) => toast.error(errorMessage(err)));

  const linkDialog = (
    <LinkTaskDialog projectId={projectId} sessionId={sessionId} linked={linkedIds} open={linking} onOpenChange={setLinking} />
  );

  if (!plan && boardTasks.length === 0) {
    // Nothing to show — keep the dialogs mounted so "Board-Aufgabe verknüpfen" from elsewhere still works.
    return (
      <>
        {linkDialog}
        <TaskDialog projectId={projectId} taskId={openTask} onClose={closeTask} />
      </>
    );
  }

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-panel/95 shadow-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">Todos</span>
          {total > 0 && (
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {done}/{total}
            </span>
          )}
          {total > 0 && (
            <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-brand transition-all" style={{ width: `${(done / total) * 100}%` }} />
            </span>
          )}
          {!open && current && <span className="min-w-0 truncate text-muted-foreground">{current}</span>}
          <ChevronRight className={cn('ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        </button>
        <Button variant="ghost" size="icon-xs" onClick={() => setLinking(true)} aria-label="Board-Aufgabe verknüpfen" title="Board-Aufgabe verknüpfen">
          <Link2 />
        </Button>
      </div>
      {open && (
        <div className="grid max-h-[38vh] gap-2 overflow-y-auto border-t border-border px-1.5 py-1.5">
          {plan && (
            <div>
              {boardTasks.length > 0 && <div className="px-1.5 pb-0.5 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Agent</div>}
              <ul>
                {plan.map((e, i) => (
                  <PlanRow key={i} entry={e} />
                ))}
              </ul>
            </div>
          )}
          {boardTasks.map((t) => (
            <TaskSection
              key={t.id}
              projectId={projectId}
              task={t}
              canUnlink={t.id !== links.data?.runTaskId}
              onUnlink={() => unlink(t.id)}
              onOpen={() => setOpenTask(t.id)}
            />
          ))}
        </div>
      )}
      {linkDialog}
      <TaskDialog projectId={projectId} taskId={openTask} onClose={closeTask} />
    </div>
  );
}

/** Opens the "link board task" dialog of the todo bar from elsewhere (session menu). */
export const todoDockEvents = new EventTarget();
