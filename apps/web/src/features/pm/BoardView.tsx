import * as React from 'react';
import { toast } from 'sonner';
import {
  closestCorners,
  type CollisionDetection,
  pointerWithin,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import { CircleDot, Flag, GitPullRequest, History, ListTodo, Plus, RefreshCw, Search, Settings2 } from 'lucide-react';
import type { Milestone, Task, TaskColumn } from '@vibe/shared';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { relativeTime, useTick } from '@/features/chat/util';
import { COLUMNS, pmApi, pmKeys, sortByRank, useLabels, useMilestones, usePmLive, usePmMutation, usePmSettings, useSyncLog, useTasks } from './api';
import { formatDateTime, LabelChip, RunBadge } from './common';
import { TaskDialog } from './TaskDialog';

type ColumnMap = Record<TaskColumn, string[]>;

const emptyColumns = (): ColumnMap => ({ backlog: [], todo: [], in_progress: [], review: [], done: [] });
const COL_PREFIX = 'col:';

/** Pointer-based collisions (cards before columns), falling back to closest corners outside all droppables. */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length) {
    const cards = within.filter((c) => !String(c.id).startsWith(COL_PREFIX));
    return cards.length ? cards : within;
  }
  return closestCorners(args);
};

// ---- card ------------------------------------------------------------------------------------

function TaskCard({ task, milestone, overlay, onOpen }: { task: Task; milestone?: Milestone; overlay?: boolean; onOpen?: () => void }) {
  const run = task.latestRun;
  return (
    <div
      onClick={onOpen}
      className={cn(
        'group grid cursor-pointer gap-1.5 rounded-lg border border-border bg-panel px-2.5 py-2 text-left shadow-xs transition-colors hover:border-foreground/20',
        overlay && 'rotate-1 cursor-grabbing shadow-xl ring-1 ring-brand/40',
      )}
    >
      <div className="text-[13px] leading-snug font-medium break-words">{task.title}</div>
      {!!task.labels.length && (
        <div className="flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      {(milestone || task.ghIssueNumber || run) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {milestone && (
            <span className="inline-flex max-w-32 items-center gap-1 truncate" title={milestone.title}>
              <Flag className="size-3 shrink-0" /> <span className="truncate">{milestone.title}</span>
            </span>
          )}
          {task.ghIssueNumber && (
            <a
              href={task.ghUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-0.5 hover:text-foreground"
            >
              <CircleDot className="size-3" />#{task.ghIssueNumber}
            </a>
          )}
          {run && <RunBadge status={run.status} />}
          {run?.prUrl && (
            <a
              href={run.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-0.5 text-brand hover:underline"
            >
              <GitPullRequest className="size-3" />PR #{run.prNumber}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function SortableCard({ task, milestone, onOpen }: { task: Task; milestone?: Milestone; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'opacity-30')}
      {...attributes}
      {...listeners}
    >
      <TaskCard task={task} milestone={milestone} onOpen={onOpen} />
    </div>
  );
}

// ---- column ---------------------------------------------------------------------------------

function QuickAdd({ projectId, column }: { projectId: string; column: TaskColumn }) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const create = usePmMutation(projectId, (t: string) => pmApi.createTask(projectId, { title: t, column }));
  const submit = () => {
    const t = title.trim();
    if (!t) return setOpen(false);
    create.mutate(t, { onSuccess: () => setTitle('') });
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3.5" /> Aufgabe hinzufügen
      </button>
    );
  }
  return (
    <Input
      autoFocus
      value={title}
      disabled={create.isPending}
      placeholder="Titel – Enter zum Anlegen"
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => !title.trim() && setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') {
          setTitle('');
          setOpen(false);
        }
      }}
      className="h-8 bg-panel text-[13px]"
    />
  );
}

function Column({
  projectId,
  id,
  label,
  ids,
  byId,
  milestones,
  onOpen,
}: {
  projectId: string;
  id: TaskColumn;
  label: string;
  ids: string[];
  byId: Map<string, Task>;
  milestones: Map<string, Milestone>;
  onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COL_PREFIX}${id}` });
  return (
    <div className="flex h-full w-72 shrink-0 flex-col rounded-xl bg-muted/40">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <span className="text-xs font-semibold tracking-wide uppercase">{label}</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{ids.length}</span>
      </div>
      <div ref={setNodeRef} className={cn('min-h-0 flex-1 overflow-y-auto px-2 pb-2 transition-colors', isOver && 'bg-accent/40')}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="grid gap-1.5">
            {ids.map((tid) => {
              const t = byId.get(tid);
              return t ? (
                <SortableCard key={tid} task={t} milestone={t.milestoneId ? milestones.get(t.milestoneId) : undefined} onOpen={() => onOpen(tid)} />
              ) : null;
            })}
          </div>
        </SortableContext>
        <div className="mt-1.5">
          <QuickAdd projectId={projectId} column={id} />
        </div>
      </div>
    </div>
  );
}

// ---- GitHub sync --------------------------------------------------------------------------

function SyncControls({ projectId }: { projectId: string }) {
  useTick(30_000);
  const settings = usePmSettings(projectId);
  const [logOpen, setLogOpen] = React.useState(false);
  const log = useSyncLog(projectId, logOpen);
  const qc = useQueryClient();
  const sync = usePmMutation(projectId, () => pmApi.sync(projectId));
  const save = usePmMutation(projectId, (v: { syncEnabled?: boolean; syncCreateIssues?: boolean }) => pmApi.saveSettings(projectId, v));
  const s = settings.data;
  if (!s?.linked) return null;
  const last = s.lastSync;
  return (
    <div className="flex items-center gap-1.5">
      {last && (
        <span className={cn('hidden text-xs md:inline', last.ok ? 'text-muted-foreground' : 'text-destructive')} title={last.message ?? undefined}>
          {last.ok ? `Sync ${relativeTime(last.at)}` : `Sync fehlgeschlagen ${relativeTime(last.at)}`}
        </span>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={sync.isPending}
        onClick={() =>
          sync.mutate(undefined, {
            onSuccess: (r) => {
              toast.success(`GitHub-Sync: ${r.pulled} übernommen, ${r.pushed} gesendet${r.conflicts ? `, ${r.conflicts} Konflikte` : ''}`);
              void qc.invalidateQueries({ queryKey: pmKeys.syncLog(projectId) });
            },
          })
        }
      >
        <RefreshCw className={cn(sync.isPending && 'animate-spin')} /> GitHub-Sync
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Sync-Einstellungen">
            <Settings2 />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>GitHub-Issues-Sync</DropdownMenuLabel>
          <DropdownMenuItem onSelect={(e) => (e.preventDefault(), save.mutate({ syncEnabled: !s.syncEnabled }))}>
            <Checkbox checked={s.syncEnabled} readOnly className="pointer-events-none" />
            Automatisch alle 2 Minuten synchronisieren
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={(e) => (e.preventDefault(), save.mutate({ syncCreateIssues: !s.syncCreateIssues }))}>
            <Checkbox checked={s.syncCreateIssues} readOnly className="pointer-events-none" />
            Neue Aufgaben als Issues anlegen
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setLogOpen(true)}>
            <History /> Sync-Protokoll
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Sync-Protokoll</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-1 overflow-y-auto text-xs">
            {(log.data ?? []).map((l) => (
              <div key={l.id} className="flex gap-2 border-b border-border py-1.5 last:border-0">
                <span className="w-24 shrink-0 text-muted-foreground">{formatDateTime(l.ts)}</span>
                <span className={cn('w-10 shrink-0 font-medium', l.direction === 'pull' ? 'text-sky-400' : 'text-brand')}>
                  {l.direction === 'pull' ? '← GH' : '→ GH'}
                </span>
                <span className="min-w-0 flex-1 break-words">{l.message}</span>
              </div>
            ))}
            {log.isSuccess && !log.data.length && <p className="py-4 text-center text-muted-foreground">Noch keine Einträge.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- board ----------------------------------------------------------------------------------

export function BoardView({ projectId }: { projectId: string }) {
  usePmLive(projectId);
  const tasks = useTasks(projectId);
  const labels = useLabels(projectId);
  const milestones = useMilestones(projectId);
  const qc = useQueryClient();
  const [query, setQuery] = React.useState('');
  const [labelFilter, setLabelFilter] = React.useState('');
  const [milestoneFilter, setMilestoneFilter] = React.useState('');
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [columns, setColumns] = React.useState<ColumnMap>(emptyColumns);
  const dragFrom = React.useRef<TaskColumn | null>(null);

  const byId = React.useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
  const msById = React.useMemo(() => new Map((milestones.data ?? []).map((m) => [m.id, m])), [milestones.data]);

  const visible = React.useCallback(
    (t: Task) => {
      const q = query.trim().toLowerCase();
      if (q && !t.title.toLowerCase().includes(q) && !t.body.toLowerCase().includes(q) && !(t.ghIssueNumber && `#${t.ghIssueNumber}`.includes(q))) return false;
      if (labelFilter && !t.labels.some((l) => l.id === labelFilter)) return false;
      if (milestoneFilter === '__none' ? !!t.milestoneId : milestoneFilter && t.milestoneId !== milestoneFilter) return false;
      return true;
    },
    [query, labelFilter, milestoneFilter],
  );

  // Server state → column order (not while dragging).
  React.useEffect(() => {
    if (activeId) return;
    const next = emptyColumns();
    for (const t of [...(tasks.data ?? [])].sort(sortByRank)) if (visible(t)) next[t.column].push(t.id);
    setColumns(next);
  }, [tasks.data, visible, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findColumn = (id: string): TaskColumn | null => {
    if (id.startsWith(COL_PREFIX)) return id.slice(COL_PREFIX.length) as TaskColumn;
    return (Object.keys(columns) as TaskColumn[]).find((c) => columns[c].includes(id)) ?? null;
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    dragFrom.current = findColumn(String(e.active.id));
  };

  const onDragOver = (e: DragOverEvent) => {
    if (!e.over) return;
    const id = String(e.active.id);
    const from = findColumn(id);
    const to = findColumn(String(e.over.id));
    if (!from || !to || from === to) return;
    setColumns((cols) => {
      const src = cols[from].filter((x) => x !== id);
      const dst = [...cols[to]];
      const overIdx = dst.indexOf(String(e.over!.id));
      dst.splice(overIdx >= 0 ? overIdx : dst.length, 0, id);
      return { ...cols, [from]: src, [to]: dst };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const origin = dragFrom.current;
    dragFrom.current = null;
    const col = findColumn(id);
    let final = columns;
    if (col && e.over) {
      const overCol = findColumn(String(e.over.id));
      if (overCol === col && !String(e.over.id).startsWith(COL_PREFIX)) {
        const oldIdx = columns[col].indexOf(id);
        const newIdx = columns[col].indexOf(String(e.over.id));
        if (oldIdx !== newIdx && newIdx >= 0) final = { ...columns, [col]: arrayMove(columns[col], oldIdx, newIdx) };
      }
    }
    setColumns(final);
    setActiveId(null);
    if (!col || !e.over) return;
    const list = final[col];
    const idx = list.indexOf(id);
    const beforeId = list[idx - 1] ?? null;
    const afterId = list[idx + 1] ?? null;
    const task = byId.get(id);
    if (!task) return;
    if (origin === col && task.column === col) {
      const server = (tasks.data ?? []).filter((t) => t.column === col && visible(t)).sort(sortByRank).map((t) => t.id);
      const si = server.indexOf(id);
      if ((server[si - 1] ?? null) === beforeId && (server[si + 1] ?? null) === afterId) return;
    }
    // Optimistic: patch the cached task's column (order is kept by the local column state until refetch).
    qc.setQueryData<Task[]>(pmKeys.tasks(projectId), (old) => old?.map((t) => (t.id === id ? { ...t, column: col } : t)));
    pmApi
      .moveTask(id, { column: col, beforeId, afterId })
      .then((t) => qc.setQueryData<Task[]>(pmKeys.tasks(projectId), (old) => old?.map((x) => (x.id === t.id ? t : x))))
      .catch((err) => toast.error(errorMessage(err)))
      .finally(() => void qc.invalidateQueries({ queryKey: pmKeys.tasks(projectId) }));
  };

  const closeDialog = React.useCallback(() => setOpenId(null), []);
  const active = activeId ? byId.get(activeId) : undefined;
  const filtered = !!(query || labelFilter || milestoneFilter);

  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="relative w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Aufgaben suchen…" className="pl-8" />
        </div>
        <Select value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)} className="w-40" aria-label="Label-Filter">
          <option value="">Alle Labels</option>
          {(labels.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Select value={milestoneFilter} onChange={(e) => setMilestoneFilter(e.target.value)} className="w-44" aria-label="Meilenstein-Filter">
          <option value="">Alle Meilensteine</option>
          <option value="__none">Ohne Meilenstein</option>
          {(milestones.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery('');
              setLabelFilter('');
              setMilestoneFilter('');
            }}
          >
            Filter zurücksetzen
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SyncControls projectId={projectId} />
        </div>
      </div>

      {tasks.isError ? (
        <div className="p-6 text-sm text-destructive">{errorMessage(tasks.error)}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
            <div className="flex h-full gap-3 p-4">
              {COLUMNS.map((c) => (
                <Column key={c.id} projectId={projectId} id={c.id} label={c.label} ids={columns[c.id]} byId={byId} milestones={msById} onOpen={setOpenId} />
              ))}
            </div>
            <DragOverlay>{active ? <TaskCard task={active} milestone={active.milestoneId ? msById.get(active.milestoneId) : undefined} overlay /> : null}</DragOverlay>
          </DndContext>
        </div>
      )}
      <TaskDialog projectId={projectId} taskId={openId} onClose={closeDialog} />
      {!tasks.isLoading && !tasks.data?.length && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1 text-xs text-muted-foreground shadow">
            <ListTodo className="size-3.5" /> Lege deine erste Aufgabe mit „Aufgabe hinzufügen“ an.
          </span>
        </div>
      )}
    </div>
  );
}
