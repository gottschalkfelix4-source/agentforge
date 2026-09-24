// Project management (Phase 5): kanban tasks, milestones, labels, notes, agent task runs.

export const TASK_COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

export interface Label {
  id: string;
  projectId: string;
  name: string;
  /** hex without '#' */
  color: string;
}

export type TaskRunStatus = 'running' | 'awaiting_review' | 'pr_open' | 'merged' | 'failed' | 'cancelled';

export interface TaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  worktreePath: string;
  branch: string;
  agentId: string;
  prNumber: number | null;
  prUrl: string | null;
  status: TaskRunStatus;
  createdAt: string;
  updatedAt: string;
}

/** Checklist item of a board task ("Unteraufgabe"). */
export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  column: TaskColumn;
  /** Fractional index string; sort ascending within a column. */
  rank: string;
  title: string;
  body: string;
  milestoneId: string | null;
  labels: Label[];
  assigneeProfileId: string | null;
  ghIssueNumber: number | null;
  ghUrl: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun: TaskRun | null;
  /** Checklist in display order. */
  subtasks: Subtask[];
}

export interface TaskInput {
  title: string;
  body?: string;
  column?: TaskColumn;
  milestoneId?: string | null;
  labelIds?: string[];
  assigneeProfileId?: string | null;
}

export interface SubtaskInput {
  title?: string;
  done?: boolean;
}

export interface MoveTaskRequest {
  column: TaskColumn;
  /** Neighbours after the move (ids); either may be null at the column edges. */
  beforeId?: string | null;
  afterId?: string | null;
}

export interface RunTaskRequest {
  agentId: string;
  profileId?: string | null;
  /** Commit, push and open a PR automatically when the agent finishes its turn. */
  autoPr?: boolean;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  dueOn: string | null;
  state: 'open' | 'closed';
  ghNumber: number | null;
  progress: { total: number; done: number };
  createdAt: string;
}

export interface MilestoneInput {
  title: string;
  description?: string;
  dueOn?: string | null;
  state?: 'open' | 'closed';
}

export interface Note {
  id: string;
  projectId: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteInput {
  title?: string;
  body?: string;
  pinned?: boolean;
}

export interface SyncLogEntry {
  id: string;
  projectId: string;
  ts: string;
  direction: 'push' | 'pull';
  entity: 'task' | 'milestone' | 'label';
  entityId: string | null;
  message: string;
}

/** Per-project PM settings (settings key `pm:<projectId>`); `linked`/`lastSync` are read-only. */
export interface PmSettings {
  syncEnabled: boolean;
  syncCreateIssues: boolean;
  linked?: boolean;
  lastSync?: PmSyncResult | null;
}

export interface PmSyncResult {
  at: string;
  ok: boolean;
  message: string | null;
  pulled: number;
  pushed: number;
  conflicts: number;
}
