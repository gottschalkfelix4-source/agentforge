import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Label,
  Milestone,
  MilestoneInput,
  MoveTaskRequest,
  Note,
  NoteInput,
  PmSettings,
  PmSyncResult,
  RunTaskRequest,
  SyncLogEntry,
  Task,
  TaskColumn,
  TaskInput,
  TaskRun,
} from '@vibe/shared';
import { request } from '@/lib/api';
import { controlSocket } from '@/lib/ws';

type Ok = { ok: true };
const p = (id: string) => `/projects/${encodeURIComponent(id)}`;
const e = encodeURIComponent;

export const pmApi = {
  tasks: (projectId: string) => request<Task[]>(`${p(projectId)}/tasks`),
  createTask: (projectId: string, body: TaskInput) => request<Task>(`${p(projectId)}/tasks`, { method: 'POST', body }),
  updateTask: (tid: string, body: Partial<TaskInput>) => request<Task>(`/tasks/${e(tid)}`, { method: 'PATCH', body }),
  deleteTask: (tid: string) => request<Ok>(`/tasks/${e(tid)}`, { method: 'DELETE' }),
  moveTask: (tid: string, body: MoveTaskRequest) => request<Task>(`/tasks/${e(tid)}/move`, { method: 'POST', body }),

  labels: (projectId: string) => request<Label[]>(`${p(projectId)}/labels`),
  createLabel: (projectId: string, body: { name: string; color?: string }) => request<Label>(`${p(projectId)}/labels`, { method: 'POST', body }),
  updateLabel: (lid: string, body: { name?: string; color?: string }) => request<Label>(`/labels/${e(lid)}`, { method: 'PATCH', body }),
  deleteLabel: (lid: string) => request<Ok>(`/labels/${e(lid)}`, { method: 'DELETE' }),

  milestones: (projectId: string) => request<Milestone[]>(`${p(projectId)}/milestones`),
  createMilestone: (projectId: string, body: MilestoneInput) => request<Milestone>(`${p(projectId)}/milestones`, { method: 'POST', body }),
  updateMilestone: (mid: string, body: Partial<MilestoneInput>) => request<Milestone>(`/milestones/${e(mid)}`, { method: 'PATCH', body }),
  deleteMilestone: (mid: string) => request<Ok>(`/milestones/${e(mid)}`, { method: 'DELETE' }),

  notes: (projectId: string) => request<Note[]>(`${p(projectId)}/notes`),
  createNote: (projectId: string, body: NoteInput) => request<Note>(`${p(projectId)}/notes`, { method: 'POST', body }),
  updateNote: (nid: string, body: NoteInput) => request<Note>(`/notes/${e(nid)}`, { method: 'PATCH', body }),
  deleteNote: (nid: string) => request<Ok>(`/notes/${e(nid)}`, { method: 'DELETE' }),

  runTask: (tid: string, body: RunTaskRequest) => request<TaskRun>(`/tasks/${e(tid)}/run`, { method: 'POST', body }),
  runs: (tid: string) => request<TaskRun[]>(`/tasks/${e(tid)}/runs`),
  finishRun: (rid: string) => request<TaskRun>(`/task-runs/${e(rid)}/finish`, { method: 'POST', body: {} }),
  cancelRun: (rid: string, removeWorktree: boolean) =>
    request<TaskRun>(`/task-runs/${e(rid)}/cancel`, { method: 'POST', body: { removeWorktree } }),

  sync: (projectId: string) => request<PmSyncResult>(`${p(projectId)}/github/sync`, { method: 'POST', body: {} }),
  syncLog: (projectId: string) => request<SyncLogEntry[]>(`${p(projectId)}/github/sync-log`, { query: { limit: 50 } }),
  settings: (projectId: string) => request<PmSettings>(`${p(projectId)}/pm-settings`),
  saveSettings: (projectId: string, body: Partial<PmSettings>) => request<PmSettings>(`${p(projectId)}/pm-settings`, { method: 'PUT', body }),
};

export const pmKeys = {
  all: (projectId: string) => ['pm', projectId] as const,
  tasks: (projectId: string) => ['pm', projectId, 'tasks'] as const,
  labels: (projectId: string) => ['pm', projectId, 'labels'] as const,
  milestones: (projectId: string) => ['pm', projectId, 'milestones'] as const,
  notes: (projectId: string) => ['pm', projectId, 'notes'] as const,
  runs: (projectId: string, tid: string) => ['pm', projectId, 'runs', tid] as const,
  settings: (projectId: string) => ['pm', projectId, 'settings'] as const,
  syncLog: (projectId: string) => ['pm', projectId, 'sync-log'] as const,
};

export const useTasks = (projectId: string) => useQuery({ queryKey: pmKeys.tasks(projectId), queryFn: () => pmApi.tasks(projectId) });
export const useLabels = (projectId: string) => useQuery({ queryKey: pmKeys.labels(projectId), queryFn: () => pmApi.labels(projectId) });
export const useMilestones = (projectId: string) =>
  useQuery({ queryKey: pmKeys.milestones(projectId), queryFn: () => pmApi.milestones(projectId) });
export const useNotes = (projectId: string) => useQuery({ queryKey: pmKeys.notes(projectId), queryFn: () => pmApi.notes(projectId) });
export const useRuns = (projectId: string, tid: string | null) =>
  useQuery({ queryKey: pmKeys.runs(projectId, tid ?? ''), queryFn: () => pmApi.runs(tid!), enabled: !!tid });
export const usePmSettings = (projectId: string) =>
  useQuery({ queryKey: pmKeys.settings(projectId), queryFn: () => pmApi.settings(projectId), staleTime: 30_000 });
export const useSyncLog = (projectId: string, enabled: boolean) =>
  useQuery({ queryKey: pmKeys.syncLog(projectId), queryFn: () => pmApi.syncLog(projectId), enabled });

/** Mutation that refreshes all PM queries of the project afterwards. */
export function usePmMutation<V, R>(projectId: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: pmKeys.all(projectId) }),
  });
}

/** Live refresh on `pm.changed` (and `session.updated`, which changes run badges). */
export function usePmLive(projectId: string) {
  const qc = useQueryClient();
  React.useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const later = (key: readonly unknown[]) => {
      const k = JSON.stringify(key);
      if (timers.has(k)) return;
      timers.set(
        k,
        setTimeout(() => {
          timers.delete(k);
          void qc.invalidateQueries({ queryKey: key });
        }, 150),
      );
    };
    const off = controlSocket.onEvent((ev) => {
      if (ev.type === 'pm.changed' && ev.projectId === projectId) {
        if (ev.entity === 'note') later(pmKeys.notes(projectId));
        else if (ev.entity === 'label') {
          later(pmKeys.labels(projectId));
          later(pmKeys.tasks(projectId));
        } else if (ev.entity === 'milestone') {
          later(pmKeys.milestones(projectId));
          later(pmKeys.tasks(projectId));
        } else {
          later(pmKeys.tasks(projectId));
          later(pmKeys.milestones(projectId));
          if (ev.entity === 'run') later(['pm', projectId, 'runs']);
          later(pmKeys.settings(projectId));
          later(pmKeys.syncLog(projectId));
        }
      } else if (ev.type === 'session.updated' && ev.projectId === projectId && ev.session.taskRunId) {
        later(['pm', projectId, 'runs']);
      }
    });
    const offState = controlSocket.onState((c) => {
      if (c) void qc.invalidateQueries({ queryKey: pmKeys.all(projectId) });
    });
    return () => {
      off();
      offState();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [projectId, qc]);
}

export const COLUMNS: { id: TaskColumn; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Arbeit' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Erledigt' },
];

export const COLUMN_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label])) as Record<TaskColumn, string>;

export const sortByRank = (a: Task, b: Task) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1);
