// Executes Agentforge tools called by coding agents (via the `agentforge-mcp` server in the workspace).
// Every call is scoped to the project of the workspace it came from.

import { TASK_COLUMNS, type Milestone, type Note, type Task, type TaskColumn } from '@vibe/shared';
import { z } from 'zod';
import { HttpError } from '../workspaces/manager.js';
import { type PmRepo, publishPm } from './repo.js';

const status = z.enum(TASK_COLUMNS);
const optionalId = z.string().trim().min(1).nullish();

const STATUS_LABEL: Record<TaskColumn, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Arbeit',
  review: 'Review',
  done: 'Erledigt',
};

const taskSummary = (t: Task) => ({
  id: t.id,
  title: t.title,
  status: t.column,
  milestoneId: t.milestoneId,
  labels: t.labels.map((l) => l.name),
  githubIssue: t.ghIssueNumber,
  ...(t.subtasks.length ? { subtasksDone: `${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}` } : {}),
  updatedAt: t.updatedAt,
});

const SUBTASK_HINT =
  'Die Unteraufgaben sind die Todo-Liste dieser Aufgabe (für den Nutzer in der Todo-Leiste des Chats sichtbar). ' +
  'Arbeitest du daran: task_set_status auf in_progress, dann jede Unteraufgabe sofort mit subtask_update {id, done: true} abhaken.';

const taskDetail = (t: Task) => ({
  ...taskSummary(t),
  description: t.body,
  subtasks: t.subtasks.map((s) => ({ id: s.id, title: s.title, done: s.done })),
  ...(t.subtasks.some((s) => !s.done) ? { subtasksHint: SUBTASK_HINT } : {}),
  githubUrl: t.ghUrl,
  createdAt: t.createdAt,
});

const milestoneSummary = (m: Milestone) => ({
  id: m.id,
  title: m.title,
  description: m.description,
  dueOn: m.dueOn,
  state: m.state,
  progress: `${m.progress.done}/${m.progress.total} erledigt`,
});

const excerpt = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const noteSummary = (n: Note) => ({ id: n.id, title: n.title, pinned: n.pinned, excerpt: excerpt(n.body), updatedAt: n.updatedAt });

export class AgentTools {
  constructor(private readonly repo: PmRepo) {}

  private task(projectId: string, id: string): Task {
    const t = this.repo.task(id);
    if (t.projectId !== projectId) throw new HttpError(404, 'not_found', 'Aufgabe nicht gefunden');
    return t;
  }

  private milestoneId(projectId: string, id: string | null | undefined) {
    if (!id) return id;
    const m = this.repo.milestone(id);
    if (m.projectId !== projectId) throw new HttpError(404, 'not_found', 'Meilenstein nicht gefunden');
    return id;
  }

  private note(projectId: string, id: string): Note {
    const n = this.repo.notes(projectId).find((x) => x.id === id);
    if (!n) throw new HttpError(404, 'not_found', 'Notiz nicht gefunden');
    return n;
  }

  private labelIds(projectId: string, names: string[] | undefined) {
    return names?.map((name) => this.repo.ensureLabel(projectId, name.trim()).id);
  }

  private currentTask(projectId: string, sessionId: string | null): Task | null {
    if (!sessionId) return null;
    const run = this.repo.runBySession(sessionId);
    if (!run) return null;
    const t = this.repo.task(run.task_id);
    return t.projectId === projectId ? t : null;
  }

  /** Board tasks this chat works on (task run + linked), shown in the chat's todo bar. */
  private sessionTasks(projectId: string, sessionId: string | null): Task[] {
    if (!sessionId) return [];
    const out: Task[] = [];
    for (const id of this.repo.sessionTaskIds(sessionId)) {
      try {
        const t = this.repo.task(id);
        if (t.projectId === projectId) out.push(t);
      } catch {
        /* deleted meanwhile */
      }
    }
    return out;
  }

  /** Remembers that this chat works on a task, so it appears in the chat's todo bar. */
  private link(sessionId: string | null, taskId: string) {
    if (sessionId) this.repo.linkSessionTask(sessionId, taskId);
  }

  /** Runs one tool; returns a JSON-serialisable result (errors are thrown as HttpError). */
  run(projectId: string, sessionId: string | null, method: string, rawParams: unknown): unknown {
    const p = (rawParams ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'project_overview': {
        const tasks = this.repo.tasks(projectId);
        const counts = Object.fromEntries(TASK_COLUMNS.map((c) => [c, tasks.filter((t) => t.column === c).length]));
        const current = this.currentTask(projectId, sessionId);
        return {
          tasksByStatus: counts,
          statuses: STATUS_LABEL,
          openMilestones: this.repo.milestones(projectId).filter((m) => m.state === 'open').map(milestoneSummary),
          inProgress: tasks.filter((t) => t.column === 'in_progress').map(taskSummary),
          pinnedNotes: this.repo.notes(projectId).filter((n) => n.pinned).map(noteSummary),
          currentTask: current ? taskDetail(current) : null,
          sessionTasks: this.sessionTasks(projectId, sessionId).map(taskSummary),
        };
      }
      case 'current_task': {
        const t = this.currentTask(projectId, sessionId);
        if (t) return taskDetail(t);
        const linked = this.sessionTasks(projectId, sessionId);
        if (linked.length) return { message: 'Aufgaben, an denen diese Sitzung arbeitet', tasks: linked.map(taskDetail) };
        return 'Diese Sitzung gehört zu keiner Aufgabe vom Board.';
      }
      case 'tasks_list': {
        const a = z.object({ status: status.optional(), milestoneId: optionalId, query: z.string().optional() }).parse(p);
        const q = a.query?.trim().toLowerCase();
        return this.repo
          .tasks(projectId)
          .filter((t) => !a.status || t.column === a.status)
          .filter((t) => !a.milestoneId || t.milestoneId === a.milestoneId)
          .filter((t) => !q || `${t.title}\n${t.body}`.toLowerCase().includes(q))
          .map(taskSummary);
      }
      case 'task_get':
        return taskDetail(this.task(projectId, z.object({ id: z.string() }).parse(p).id));
      case 'task_create': {
        const a = z
          .object({
            title: z.string().trim().min(1).max(300),
            description: z.string().max(100_000).optional(),
            status: status.optional(),
            milestoneId: optionalId,
            labels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
            subtasks: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
          })
          .parse(p);
        const row = this.repo.createTask(projectId, {
          title: a.title,
          body: a.description,
          column: a.status ?? 'todo',
          milestoneId: this.milestoneId(projectId, a.milestoneId) ?? null,
          labelIds: this.labelIds(projectId, a.labels),
        });
        if (a.subtasks?.length) this.repo.addSubtasks(row.id, a.subtasks);
        if (a.status === 'in_progress') this.link(sessionId, row.id);
        publishPm(projectId, 'task');
        if (a.labels?.length) publishPm(projectId, 'label');
        return taskDetail(this.repo.task(row.id));
      }
      case 'task_update': {
        const a = z
          .object({
            id: z.string(),
            title: z.string().trim().min(1).max(300).optional(),
            description: z.string().max(100_000).optional(),
            status: status.optional(),
            milestoneId: z.string().trim().min(1).nullable().optional(),
            labels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
          })
          .parse(p);
        this.task(projectId, a.id);
        this.repo.updateTask(a.id, {
          title: a.title,
          body: a.description,
          column: a.status,
          milestoneId: a.milestoneId === undefined ? undefined : this.milestoneId(projectId, a.milestoneId),
          labelIds: this.labelIds(projectId, a.labels),
        });
        if (a.status === 'in_progress' || a.status === 'review') this.link(sessionId, a.id);
        publishPm(projectId, 'task');
        return taskDetail(this.repo.task(a.id));
      }
      case 'subtasks_add': {
        const a = z.object({ taskId: z.string(), titles: z.array(z.string().trim().min(1).max(300)).min(1).max(50) }).parse(p);
        this.task(projectId, a.taskId);
        this.repo.addSubtasks(a.taskId, a.titles);
        this.link(sessionId, a.taskId);
        publishPm(projectId, 'task');
        return taskDetail(this.repo.task(a.taskId));
      }
      case 'subtask_update': {
        const a = z.object({ id: z.string(), done: z.boolean().optional(), title: z.string().trim().min(1).max(300).optional() }).parse(p);
        const s = this.repo.subtaskRow(a.id);
        this.task(projectId, s.task_id);
        this.repo.updateSubtask(a.id, { done: a.done, title: a.title });
        this.link(sessionId, s.task_id);
        publishPm(projectId, 'task');
        const t = this.repo.task(s.task_id);
        return { taskId: t.id, subtasks: t.subtasks, subtasksDone: `${t.subtasks.filter((x) => x.done).length}/${t.subtasks.length}` };
      }
      case 'task_set_status': {
        const a = z.object({ id: z.string(), status }).parse(p);
        const t = this.task(projectId, a.id);
        if (t.column !== a.status) this.repo.moveTask(a.id, a.status);
        if (a.status === 'in_progress' || a.status === 'review') this.link(sessionId, a.id);
        publishPm(projectId, 'task');
        return { ...taskSummary(this.repo.task(a.id)), message: `Status: ${STATUS_LABEL[a.status]}` };
      }
      case 'milestones_list':
        return this.repo.milestones(projectId).map(milestoneSummary);
      case 'milestone_create': {
        const a = z
          .object({
            title: z.string().trim().min(1).max(200),
            description: z.string().max(20_000).optional(),
            dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als YYYY-MM-DD').optional(),
          })
          .parse(p);
        const m = this.repo.createMilestone(projectId, { title: a.title, description: a.description, dueOn: a.dueOn ?? null });
        publishPm(projectId, 'milestone');
        return milestoneSummary(this.repo.milestone(m.id));
      }
      case 'milestone_update': {
        const a = z
          .object({
            id: z.string(),
            title: z.string().trim().min(1).max(200).optional(),
            description: z.string().max(20_000).optional(),
            dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als YYYY-MM-DD').nullable().optional(),
            state: z.enum(['open', 'closed']).optional(),
          })
          .parse(p);
        this.milestoneId(projectId, a.id);
        this.repo.updateMilestone(a.id, { title: a.title, description: a.description, due_on: a.dueOn, state: a.state });
        publishPm(projectId, 'milestone');
        return milestoneSummary(this.repo.milestone(a.id));
      }
      case 'notes_list': {
        const q = z.object({ query: z.string().optional() }).parse(p).query?.trim().toLowerCase();
        return this.repo
          .notes(projectId)
          .filter((n) => !q || `${n.title}\n${n.body}`.toLowerCase().includes(q))
          .map(noteSummary);
      }
      case 'note_get': {
        const n = this.note(projectId, z.object({ id: z.string() }).parse(p).id);
        return { id: n.id, title: n.title, pinned: n.pinned, body: n.body, updatedAt: n.updatedAt };
      }
      case 'note_create': {
        const a = z
          .object({ title: z.string().trim().min(1).max(200), body: z.string().max(200_000).optional(), pinned: z.boolean().optional() })
          .parse(p);
        const n = this.repo.createNote(projectId, { title: a.title, body: a.body ?? '', pinned: a.pinned });
        publishPm(projectId, 'note');
        return noteSummary(n);
      }
      case 'note_update': {
        const a = z
          .object({
            id: z.string(),
            title: z.string().trim().min(1).max(200).optional(),
            body: z.string().max(200_000).optional(),
            append: z.string().max(200_000).optional(),
            pinned: z.boolean().optional(),
          })
          .parse(p);
        const n = this.note(projectId, a.id);
        const body = a.append !== undefined ? `${a.body ?? n.body}${n.body && !a.body ? '\n\n' : ''}${a.append}` : a.body;
        const updated = this.repo.updateNote(a.id, { title: a.title, body, pinned: a.pinned });
        publishPm(projectId, 'note');
        return noteSummary(updated);
      }
      default:
        throw new HttpError(400, 'unknown_tool', `Unbekanntes Tool: ${method}`);
    }
  }
}
