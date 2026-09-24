import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, ListChecks, Plus, X } from 'lucide-react';
import type { Subtask, Task } from '@vibe/shared';
import { cn, errorMessage } from '@/lib/utils';
import { pmApi, pmKeys } from './api';

/** "2/5" with a check icon; green when everything is done. */
export function SubtaskProgress({ subtasks, className }: { subtasks: Subtask[]; className?: string }) {
  const done = subtasks.filter((s) => s.done).length;
  const all = done === subtasks.length;
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 tabular-nums', all ? 'text-success' : 'text-muted-foreground', className)}
      title={`${done} von ${subtasks.length} Unteraufgaben erledigt`}
    >
      <ListChecks className="size-3" />
      {done}/{subtasks.length}
    </span>
  );
}

/** Round checkbox used for subtasks (and read-only agent todos). */
export function CheckCircle({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
        checked ? 'border-success bg-success text-background' : 'border-muted-foreground/50',
        className,
      )}
    >
      {checked && <Check className="size-2.5" strokeWidth={3} />}
    </span>
  );
}

/** Edits a task's subtasks with optimistic updates of the cached task list. */
function useSubtaskActions(projectId: string, taskId: string) {
  const qc = useQueryClient();
  const key = pmKeys.tasks(projectId);
  const patchCache = (fn: (subtasks: Subtask[]) => Subtask[]) =>
    qc.setQueryData<Task[]>(key, (old) => old?.map((t) => (t.id === taskId ? { ...t, subtasks: fn(t.subtasks) } : t)));
  const run = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
  return {
    rename: (s: Subtask, title: string) => {
      patchCache((list) => list.map((x) => (x.id === s.id ? { ...x, title } : x)));
      return run(pmApi.updateSubtask(s.id, { title }));
    },
    remove: (s: Subtask) => {
      patchCache((list) => list.filter((x) => x.id !== s.id));
      return run(pmApi.deleteSubtask(s.id));
    },
    add: (titles: string[]) => run(pmApi.addSubtasks(taskId, titles)),
  };
}

function SubtaskRow({
  subtask,
  compact,
  onRename,
  onRemove,
}: {
  subtask: Subtask;
  compact?: boolean;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(subtask.title);
  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== subtask.title) onRename(t);
    else setDraft(subtask.title);
  };
  return (
    <li className={cn('group flex items-start gap-2 rounded-md px-1.5', compact ? 'py-0.5' : 'py-1 hover:bg-accent/50')}>
      {/* Only the agent ticks subtasks off (board tools); for the user the state is read-only. */}
      <span
        role="img"
        aria-label={subtask.done ? 'Erledigt' : 'Offen'}
        title={subtask.done ? 'Vom Agent erledigt' : 'Offen – wird vom Agent abgehakt'}
        className="mt-[3px]"
      >
        <CheckCircle checked={subtask.done} />
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(subtask.title);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded border border-input bg-background px-1 text-[13px] outline-none"
        />
      ) : (
        <span
          onDoubleClick={() => setEditing(true)}
          title="Doppelklick zum Umbenennen"
          className={cn(
            'min-w-0 flex-1 break-words',
            compact ? 'text-[12.5px]' : 'text-[13px]',
            subtask.done && 'text-muted-foreground line-through decoration-muted-foreground/40',
          )}
        >
          {subtask.title}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Unteraufgabe löschen"
        className="mt-0.5 cursor-pointer text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </li>
  );
}

/** Checklist of a board task: rename (double click), delete, add (several at once with one line each). */
export function SubtaskList({ projectId, task, compact }: { projectId: string; task: Task; compact?: boolean }) {
  const actions = useSubtaskActions(projectId, task.id);
  const [draft, setDraft] = React.useState('');
  const submit = (text = draft) => {
    const titles = text
      .split('\n')
      .map((s) => s.replace(/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?/, '').trim())
      .filter(Boolean);
    if (!titles.length) return;
    setDraft('');
    void actions.add(titles);
  };
  return (
    <div>
      {task.subtasks.length > 0 && (
        <ul className="grid">
          {task.subtasks.map((s) => (
            <SubtaskRow
              key={s.id}
              subtask={s}
              compact={compact}
              onRename={(t) => void actions.rename(s, t)}
              onRemove={() => void actions.remove(s)}
            />
          ))}
        </ul>
      )}
      <div className={cn('flex items-center gap-2 px-1.5', compact ? 'py-0.5' : 'py-1')}>
        <Plus className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            // Pasting a list (e.g. a Markdown checklist) adds one subtask per line.
            const text = e.clipboardData.getData('text');
            if (text.includes('\n')) {
              e.preventDefault();
              submit(draft + text);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Unteraufgabe hinzufügen…"
          className={cn('min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70', compact ? 'text-[12.5px]' : 'text-[13px]')}
        />
      </div>
    </div>
  );
}
