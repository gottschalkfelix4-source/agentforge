import type { Label, Milestone, Note, Subtask, SyncLogEntry, Task, TaskColumn, TaskRun, TaskRunStatus } from '@vibe/shared';
import { ulid } from 'ulid';
import { nowIso, type Db } from '../db/index.js';
import { bus } from '../events.js';
import { HttpError } from '../workspaces/manager.js';
import { planMove, rankAtEnd } from './rank.js';

// ---- rows ---------------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  project_id: string;
  col: TaskColumn;
  rank: string;
  title: string;
  body: string;
  milestone_id: string | null;
  assignee_profile_id: string | null;
  gh_issue_number: number | null;
  gh_url: string | null;
  gh_updated_at: string | null;
  sync_state: string;
  created_at: string;
  updated_at: string;
}

export interface LabelRow {
  id: string;
  project_id: string;
  name: string;
  color: string;
}

export interface MilestoneRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  due_on: string | null;
  state: 'open' | 'closed';
  gh_number: number | null;
  gh_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: string;
  project_id: string;
  title: string;
  body: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  task_id: string;
  session_id: string | null;
  worktree_path: string;
  branch: string;
  agent_id: string;
  auto_pr: number;
  pr_number: number | null;
  pr_url: string | null;
  status: TaskRunStatus;
  created_at: string;
  updated_at: string;
  base_branch: string | null;
  base_sha: string | null;
  profile_id: string | null;
}

export interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  done: number;
  position: number;
  created_at: string;
  updated_at: string;
}

type SqlPatch = Record<string, string | number | null | undefined>;

const toSubtask = (r: SubtaskRow): Subtask => ({ id: r.id, title: r.title, done: !!r.done });

export const toLabel = (r: LabelRow): Label => ({ id: r.id, projectId: r.project_id, name: r.name, color: r.color });

export const toRun = (r: RunRow): TaskRun => ({
  id: r.id,
  taskId: r.task_id,
  sessionId: r.session_id,
  worktreePath: r.worktree_path,
  branch: r.branch,
  agentId: r.agent_id,
  prNumber: r.pr_number,
  prUrl: r.pr_url,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toNote = (r: NoteRow): Note => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  body: r.body,
  pinned: !!r.pinned,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type PmEntity = 'task' | 'milestone' | 'label' | 'note' | 'run';

export function publishPm(projectId: string, entity: PmEntity) {
  bus.project(projectId, { type: 'pm.changed', projectId, entity });
}

const LABEL_COLORS = ['e11d48', 'f97316', 'eab308', '22c55e', '14b8a6', '3b82f6', '8b5cf6', 'ec4899', '64748b'];

export interface TaskFields {
  title?: string;
  body?: string;
  column?: TaskColumn;
  milestoneId?: string | null;
  labelIds?: string[];
  assigneeProfileId?: string | null;
}

/** Data access for project management (tasks, labels, milestones, notes, runs, sync log). */
export class PmRepo {
  constructor(readonly db: Db) {}

  projectExists(projectId: string) {
    if (!this.db.get('SELECT id FROM projects WHERE id = ?', projectId)) throw new HttpError(404, 'not_found', 'Projekt nicht gefunden');
  }

  // ---- labels ------------------------------------------------------------------------------

  labels(projectId: string): Label[] {
    return this.db.all<LabelRow>('SELECT * FROM labels WHERE project_id = ? ORDER BY name COLLATE NOCASE', projectId).map(toLabel);
  }

  labelRow(id: string): LabelRow {
    const r = this.db.get<LabelRow>('SELECT * FROM labels WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'not_found', 'Label nicht gefunden');
    return r;
  }

  labelByName(projectId: string, name: string): LabelRow | undefined {
    return this.db.get<LabelRow>('SELECT * FROM labels WHERE project_id = ? AND name = ? COLLATE NOCASE', projectId, name);
  }

  createLabel(projectId: string, name: string, color?: string | null): Label {
    this.projectExists(projectId);
    if (this.labelByName(projectId, name)) throw new HttpError(409, 'label_exists', `Label „${name}“ existiert bereits`);
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM labels WHERE project_id = ?', projectId)!.n;
    const id = ulid();
    this.db.insert('labels', { id, project_id: projectId, name, color: (color || LABEL_COLORS[Number(count) % LABEL_COLORS.length]!).toLowerCase() });
    return toLabel(this.labelRow(id));
  }

  /** Label by name, created (with the given color) if missing. */
  ensureLabel(projectId: string, name: string, color?: string | null): LabelRow {
    const hit = this.labelByName(projectId, name);
    if (hit) return hit;
    return this.labelRow(this.createLabel(projectId, name, color).id);
  }

  updateLabel(id: string, patch: { name?: string; color?: string }): Label {
    const r = this.labelRow(id);
    if (patch.name && patch.name.toLowerCase() !== r.name.toLowerCase() && this.labelByName(r.project_id, patch.name)) {
      throw new HttpError(409, 'label_exists', `Label „${patch.name}“ existiert bereits`);
    }
    this.db.update('labels', id, { name: patch.name, color: patch.color?.toLowerCase() });
    return toLabel(this.labelRow(id));
  }

  /** Deleting a label counts as a change of every task that carried it (sync pushes the new label set). */
  deleteLabel(id: string): LabelRow {
    const r = this.labelRow(id);
    this.db.tx(() => {
      this.db.run('UPDATE tasks SET updated_at = ? WHERE id IN (SELECT task_id FROM task_labels WHERE label_id = ?)', nowIso(), id);
      this.db.run('DELETE FROM labels WHERE id = ?', id);
    });
    return r;
  }

  // ---- milestones ------------------------------------------------------------------------

  milestoneRow(id: string): MilestoneRow {
    const r = this.db.get<MilestoneRow>('SELECT * FROM milestones WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'not_found', 'Meilenstein nicht gefunden');
    return r;
  }

  milestoneRows(projectId: string): MilestoneRow[] {
    return this.db.all<MilestoneRow>('SELECT * FROM milestones WHERE project_id = ? ORDER BY due_on IS NULL, due_on, created_at', projectId);
  }

  milestones(projectId: string): Milestone[] {
    const progress = new Map(
      this.db
        .all<{ milestone_id: string; total: number; done: number | null }>(
          `SELECT milestone_id, COUNT(*) AS total, SUM(CASE WHEN col = 'done' THEN 1 ELSE 0 END) AS done
             FROM tasks WHERE project_id = ? AND milestone_id IS NOT NULL GROUP BY milestone_id`,
          projectId,
        )
        .map((r) => [r.milestone_id, { total: Number(r.total), done: Number(r.done ?? 0) }]),
    );
    return this.milestoneRows(projectId).map((r) => this.toMilestone(r, progress.get(r.id)));
  }

  milestone(id: string): Milestone {
    const r = this.milestoneRow(id);
    const p = this.db.get<{ total: number; done: number | null }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN col = 'done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE milestone_id = ?`,
      id,
    );
    return this.toMilestone(r, p ? { total: Number(p.total), done: Number(p.done ?? 0) } : undefined);
  }

  private toMilestone(r: MilestoneRow, progress?: { total: number; done: number }): Milestone {
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      description: r.description,
      dueOn: r.due_on,
      state: r.state,
      ghNumber: r.gh_number,
      progress: progress ?? { total: 0, done: 0 },
      createdAt: r.created_at,
    };
  }

  createMilestone(
    projectId: string,
    input: { title: string; description?: string; dueOn?: string | null; state?: 'open' | 'closed' },
    extra: Partial<MilestoneRow> = {},
  ): MilestoneRow {
    this.projectExists(projectId);
    const id = ulid();
    const now = nowIso();
    this.db.insert('milestones', {
      id,
      project_id: projectId,
      title: input.title,
      description: input.description ?? '',
      due_on: input.dueOn ?? null,
      state: input.state ?? 'open',
      gh_number: null,
      gh_updated_at: null,
      created_at: now,
      updated_at: now,
      ...extra,
    });
    return this.milestoneRow(id);
  }

  updateMilestone(id: string, patch: Partial<Pick<MilestoneRow, 'title' | 'description' | 'due_on' | 'state' | 'gh_number' | 'gh_updated_at' | 'updated_at'>>) {
    this.milestoneRow(id);
    this.db.update('milestones', id, { updated_at: nowIso(), ...patch });
    return this.milestoneRow(id);
  }

  deleteMilestone(id: string): MilestoneRow {
    const r = this.milestoneRow(id);
    this.db.tx(() => {
      this.db.run('UPDATE tasks SET updated_at = ? WHERE milestone_id = ?', nowIso(), id);
      this.db.run('DELETE FROM milestones WHERE id = ?', id);
    });
    return r;
  }

  // ---- tasks --------------------------------------------------------------------------------

  taskRow(id: string): TaskRow {
    const r = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'not_found', 'Aufgabe nicht gefunden');
    return r;
  }

  taskRows(projectId: string): TaskRow[] {
    return this.db.all<TaskRow>('SELECT * FROM tasks WHERE project_id = ? ORDER BY col, rank', projectId);
  }

  taskLabelRows(taskId: string): LabelRow[] {
    return this.db.all<LabelRow>(
      'SELECT l.* FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = ? ORDER BY l.name COLLATE NOCASE',
      taskId,
    );
  }

  private labelsOfTasks(projectId: string): Map<string, Label[]> {
    const out = new Map<string, Label[]>();
    for (const r of this.db.all<LabelRow & { task_id: string }>(
      `SELECT tl.task_id, l.* FROM task_labels tl JOIN labels l ON l.id = tl.label_id
        WHERE l.project_id = ? ORDER BY l.name COLLATE NOCASE`,
      projectId,
    )) {
      const list = out.get(r.task_id) ?? [];
      list.push(toLabel(r));
      out.set(r.task_id, list);
    }
    return out;
  }

  private latestRuns(projectId: string): Map<string, RunRow> {
    const out = new Map<string, RunRow>();
    for (const r of this.db.all<RunRow>(
      'SELECT r.* FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? ORDER BY r.created_at, r.id',
      projectId,
    )) {
      out.set(r.task_id, r);
    }
    return out;
  }

  private subtasksOfTasks(projectId: string): Map<string, Subtask[]> {
    const out = new Map<string, Subtask[]>();
    for (const r of this.db.all<SubtaskRow>(
      'SELECT s.* FROM task_subtasks s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? ORDER BY s.position, s.id',
      projectId,
    )) {
      const list = out.get(r.task_id) ?? [];
      list.push(toSubtask(r));
      out.set(r.task_id, list);
    }
    return out;
  }

  tasks(projectId: string): Task[] {
    const labels = this.labelsOfTasks(projectId);
    const runs = this.latestRuns(projectId);
    const subtasks = this.subtasksOfTasks(projectId);
    return this.taskRows(projectId).map((r) => this.toTask(r, labels.get(r.id) ?? [], runs.get(r.id), subtasks.get(r.id)));
  }

  task(id: string): Task {
    const r = this.taskRow(id);
    const run = this.db.get<RunRow>('SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', id);
    return this.toTask(r, this.taskLabelRows(id).map(toLabel), run, this.subtasks(id));
  }

  private toTask(r: TaskRow, labels: Label[], run?: RunRow, subtasks?: Subtask[]): Task {
    return {
      id: r.id,
      projectId: r.project_id,
      column: r.col,
      rank: r.rank,
      title: r.title,
      body: r.body,
      milestoneId: r.milestone_id,
      labels,
      assigneeProfileId: r.assignee_profile_id,
      ghIssueNumber: r.gh_issue_number,
      ghUrl: r.gh_url,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      latestRun: run ? toRun(run) : null,
      subtasks: subtasks ?? [],
    };
  }

  columnRanks(projectId: string, col: TaskColumn) {
    return this.db.all<{ id: string; rank: string }>('SELECT id, rank FROM tasks WHERE project_id = ? AND col = ?', projectId, col);
  }

  private checkMilestone(projectId: string, milestoneId: string | null | undefined) {
    if (!milestoneId) return;
    const m = this.db.get<{ project_id: string }>('SELECT project_id FROM milestones WHERE id = ?', milestoneId);
    if (!m || m.project_id !== projectId) throw new HttpError(400, 'invalid_milestone', 'Meilenstein gehört nicht zu diesem Projekt');
  }

  setTaskLabels(taskId: string, projectId: string, labelIds: string[]) {
    const unique = [...new Set(labelIds)];
    for (const lid of unique) {
      const l = this.db.get<{ project_id: string }>('SELECT project_id FROM labels WHERE id = ?', lid);
      if (!l || l.project_id !== projectId) throw new HttpError(400, 'invalid_label', 'Label gehört nicht zu diesem Projekt');
    }
    this.db.run('DELETE FROM task_labels WHERE task_id = ?', taskId);
    for (const lid of unique) this.db.run('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)', taskId, lid);
  }

  createTask(projectId: string, input: TaskFields & { title: string }, extra: Partial<TaskRow> = {}): TaskRow {
    this.projectExists(projectId);
    this.checkMilestone(projectId, input.milestoneId);
    const col = input.column ?? 'backlog';
    const id = ulid();
    const now = nowIso();
    this.db.tx(() => {
      this.db.insert('tasks', {
        id,
        project_id: projectId,
        col,
        rank: rankAtEnd(this.columnRanks(projectId, col)),
        title: input.title,
        body: input.body ?? '',
        milestone_id: input.milestoneId ?? null,
        assignee_profile_id: input.assigneeProfileId ?? null,
        gh_issue_number: null,
        gh_url: null,
        gh_updated_at: null,
        sync_state: 'local',
        created_at: now,
        updated_at: now,
        ...extra,
      });
      if (input.labelIds?.length) this.setTaskLabels(id, projectId, input.labelIds);
    });
    return this.taskRow(id);
  }

  updateTask(id: string, input: TaskFields, extra: Partial<TaskRow> = {}): TaskRow {
    const r = this.taskRow(id);
    this.checkMilestone(r.project_id, input.milestoneId);
    this.db.tx(() => {
      const patch: Partial<TaskRow> = {
        title: input.title,
        body: input.body,
        milestone_id: input.milestoneId,
        assignee_profile_id: input.assigneeProfileId,
        updated_at: nowIso(),
      };
      if (input.column && input.column !== r.col) {
        patch.col = input.column;
        patch.rank = rankAtEnd(this.columnRanks(r.project_id, input.column));
      }
      this.db.update('tasks', id, { ...patch, ...extra } as SqlPatch);
      if (input.labelIds) this.setTaskLabels(id, r.project_id, input.labelIds);
    });
    return this.taskRow(id);
  }

  moveTask(id: string, col: TaskColumn, beforeId?: string | null, afterId?: string | null): TaskRow {
    const r = this.taskRow(id);
    this.db.tx(() => {
      const plan = planMove(this.columnRanks(r.project_id, col), id, beforeId, afterId);
      if (plan.rebalance) {
        for (const [tid, rank] of plan.rebalance) if (tid !== id) this.db.run('UPDATE tasks SET rank = ? WHERE id = ?', rank, tid);
      }
      this.db.update('tasks', id, { col, rank: plan.rank, updated_at: nowIso() });
    });
    return this.taskRow(id);
  }

  deleteTask(id: string): TaskRow {
    const r = this.taskRow(id);
    this.db.run('DELETE FROM tasks WHERE id = ?', id);
    return r;
  }

  // ---- subtasks ---------------------------------------------------------------------------------
  // Local checklist items (not synced to GitHub); changing them does not touch the task's updated_at,
  // so the issue sync does not push unchanged tasks.

  subtasks(taskId: string): Subtask[] {
    return this.db.all<SubtaskRow>('SELECT * FROM task_subtasks WHERE task_id = ? ORDER BY position, id', taskId).map(toSubtask);
  }

  subtaskRow(id: string): SubtaskRow {
    const r = this.db.get<SubtaskRow>('SELECT * FROM task_subtasks WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'not_found', 'Unteraufgabe nicht gefunden');
    return r;
  }

  addSubtasks(taskId: string, titles: string[]): SubtaskRow[] {
    this.taskRow(taskId);
    const now = nowIso();
    const ids: string[] = [];
    this.db.tx(() => {
      let pos = Number(this.db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM task_subtasks WHERE task_id = ?', taskId)?.p ?? -1);
      for (const title of titles) {
        const id = ulid();
        ids.push(id);
        this.db.insert('task_subtasks', { id, task_id: taskId, title, done: 0, position: ++pos, created_at: now, updated_at: now });
      }
    });
    return ids.map((id) => this.subtaskRow(id));
  }

  updateSubtask(id: string, patch: { title?: string; done?: boolean }): SubtaskRow {
    this.subtaskRow(id);
    this.db.update('task_subtasks', id, {
      title: patch.title,
      done: patch.done === undefined ? undefined : patch.done ? 1 : 0,
      updated_at: nowIso(),
    });
    return this.subtaskRow(id);
  }

  deleteSubtask(id: string): SubtaskRow {
    const r = this.subtaskRow(id);
    this.db.run('DELETE FROM task_subtasks WHERE id = ?', id);
    return r;
  }

  /** New order of a task's subtasks (ids not listed keep their relative order at the end). */
  reorderSubtasks(taskId: string, ids: string[]) {
    const current = this.db.all<{ id: string }>('SELECT id FROM task_subtasks WHERE task_id = ? ORDER BY position, id', taskId).map((r) => r.id);
    const order = [...ids.filter((id) => current.includes(id)), ...current.filter((id) => !ids.includes(id))];
    this.db.tx(() => order.forEach((id, i) => this.db.run('UPDATE task_subtasks SET position = ? WHERE id = ?', i, id)));
  }

  // ---- tasks of chat sessions -------------------------------------------------------------------

  /** Board tasks a chat session works on: its task run's task plus explicitly linked ones (oldest first). */
  sessionTaskIds(sessionId: string): string[] {
    const ids = this.db
      .all<{ task_id: string }>('SELECT task_id FROM session_tasks WHERE session_id = ? ORDER BY created_at, task_id', sessionId)
      .map((r) => r.task_id);
    const run = this.runBySession(sessionId);
    return run && !ids.includes(run.task_id) ? [run.task_id, ...ids] : ids;
  }

  /** Returns true when the link is new. */
  linkSessionTask(sessionId: string, taskId: string): boolean {
    const r = this.db.run('INSERT OR IGNORE INTO session_tasks (session_id, task_id, created_at) VALUES (?, ?, ?)', sessionId, taskId, nowIso());
    return Number(r.changes) > 0;
  }

  unlinkSessionTask(sessionId: string, taskId: string) {
    this.db.run('DELETE FROM session_tasks WHERE session_id = ? AND task_id = ?', sessionId, taskId);
  }

  // ---- notes ----------------------------------------------------------------------------------

  notes(projectId: string): Note[] {
    return this.db.all<NoteRow>('SELECT * FROM notes WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC', projectId).map(toNote);
  }

  noteRow(id: string): NoteRow {
    const r = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'not_found', 'Notiz nicht gefunden');
    return r;
  }

  createNote(projectId: string, input: { title?: string; body?: string; pinned?: boolean }): Note {
    this.projectExists(projectId);
    const id = ulid();
    const now = nowIso();
    this.db.insert('notes', {
      id,
      project_id: projectId,
      title: input.title?.trim() || 'Neue Notiz',
      body: input.body ?? '',
      pinned: input.pinned ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    return toNote(this.noteRow(id));
  }

  updateNote(id: string, input: { title?: string; body?: string; pinned?: boolean }): Note {
    this.noteRow(id);
    this.db.update('notes', id, {
      title: input.title,
      body: input.body,
      pinned: input.pinned === undefined ? undefined : input.pinned ? 1 : 0,
      updated_at: nowIso(),
    });
    return toNote(this.noteRow(id));
  }

  deleteNote(id: string): NoteRow {
    const r = this.noteRow(id);
    this.db.run('DELETE FROM notes WHERE id = ?', id);
    return r;
  }

  // ---- runs -------------------------------------------------------------------------------------

  runRow(id: string): RunRow {
    const r = this.db.get<RunRow>('SELECT * FROM task_runs WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'not_found', 'Agent-Lauf nicht gefunden');
    return r;
  }

  runs(taskId: string): TaskRun[] {
    return this.db.all<RunRow>('SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC', taskId).map(toRun);
  }

  runBySession(sessionId: string): RunRow | undefined {
    return this.db.get<RunRow>('SELECT * FROM task_runs WHERE session_id = ?', sessionId);
  }

  updateRun(id: string, patch: Partial<Omit<RunRow, 'id'>>): RunRow {
    this.db.update('task_runs', id, { ...patch, updated_at: nowIso() } as SqlPatch);
    return this.runRow(id);
  }

  // ---- sync log / settings -------------------------------------------------------------------

  log(projectId: string, direction: 'push' | 'pull', entity: 'task' | 'milestone' | 'label', entityId: string | null, message: string) {
    this.db.insert('sync_log', { id: ulid(), project_id: projectId, ts: nowIso(), direction, entity, entity_id: entityId, message });
  }

  syncLog(projectId: string, limit = 100): SyncLogEntry[] {
    return this.db
      .all<{ id: string; project_id: string; ts: string; direction: 'push' | 'pull'; entity: 'task' | 'milestone' | 'label'; entity_id: string | null; message: string }>(
        'SELECT * FROM sync_log WHERE project_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
        projectId,
        limit,
      )
      .map((r) => ({ id: r.id, projectId: r.project_id, ts: r.ts, direction: r.direction, entity: r.entity, entityId: r.entity_id, message: r.message }));
  }

  readSetting<T>(key: string): T | null {
    const r = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
    if (!r) return null;
    try {
      return JSON.parse(r.value_json) as T;
    } catch {
      return null;
    }
  }

  writeSetting(key: string, value: unknown) {
    this.db.run(
      'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      key,
      JSON.stringify(value),
    );
  }
}
