import { describe, expect, it } from 'vitest';
import { Db, nowIso } from '../db/index.js';
import { AgentTools } from './agent-tools.js';
import { PmRepo } from './repo.js';

const db = new Db(':memory:');
const repo = new PmRepo(db);
const tools = new AgentTools(repo);

let n = 0;
function project() {
  const id = `ap${++n}`;
  db.insert('projects', { id, name: id, slug: id, git_url: null, default_branch: null, created_at: nowIso(), archived: 0 });
  return id;
}

type Obj = Record<string, unknown>;

describe('agent tools', () => {
  it('creates tasks with labels and moves them through the statuses', () => {
    const p = project();
    const t = tools.run(p, null, 'task_create', { title: 'Login bauen', description: 'OAuth', labels: ['auth', 'auth '] }) as Obj;
    expect(t).toMatchObject({ title: 'Login bauen', status: 'todo', labels: ['auth'], description: 'OAuth' });

    const moved = tools.run(p, null, 'task_set_status', { id: t.id, status: 'in_progress' }) as Obj;
    expect(moved).toMatchObject({ status: 'in_progress', message: 'Status: In Arbeit' });

    const list = tools.run(p, null, 'tasks_list', { status: 'in_progress' }) as Obj[];
    expect(list.map((x) => x.title)).toEqual(['Login bauen']);
    expect(tools.run(p, null, 'tasks_list', { query: 'oauth' })).toHaveLength(1);

    const upd = tools.run(p, null, 'task_update', { id: t.id, title: 'Login mit GitHub', labels: [] }) as Obj;
    expect(upd).toMatchObject({ title: 'Login mit GitHub', labels: [] });

    const overview = tools.run(p, null, 'project_overview', {}) as { tasksByStatus: Record<string, number> };
    expect(overview.tasksByStatus.in_progress).toBe(1);
  });

  it('manages milestones and links tasks to them', () => {
    const p = project();
    const m = tools.run(p, null, 'milestone_create', { title: 'MVP', dueOn: '2026-10-15' }) as Obj;
    tools.run(p, null, 'task_create', { title: 'A', milestoneId: m.id, status: 'done' });
    tools.run(p, null, 'task_create', { title: 'B', milestoneId: m.id });
    const [listed] = tools.run(p, null, 'milestones_list', {}) as Obj[];
    expect(listed).toMatchObject({ title: 'MVP', dueOn: '2026-10-15', progress: '1/2 erledigt' });
    expect(tools.run(p, null, 'milestone_update', { id: m.id, state: 'closed' })).toMatchObject({ state: 'closed' });
    expect(() => tools.run(p, null, 'milestone_create', { title: 'X', dueOn: '15.10.2026' })).toThrow();
  });

  it('reads, creates and appends to notes', () => {
    const p = project();
    const note = tools.run(p, null, 'note_create', { title: 'Architektur', body: 'React + Fastify' }) as Obj;
    tools.run(p, null, 'note_update', { id: note.id, append: 'DB: SQLite' });
    expect(tools.run(p, null, 'note_get', { id: note.id })).toMatchObject({ body: 'React + Fastify\n\nDB: SQLite' });
    expect(tools.run(p, null, 'notes_list', { query: 'sqlite' })).toHaveLength(1);
  });

  it('never touches another project', () => {
    const a = project();
    const b = project();
    const t = tools.run(a, null, 'task_create', { title: 'geheim' }) as Obj;
    const m = tools.run(a, null, 'milestone_create', { title: 'M' }) as Obj;
    const note = tools.run(a, null, 'note_create', { title: 'N' }) as Obj;
    expect(() => tools.run(b, null, 'task_get', { id: t.id })).toThrow(/nicht gefunden/);
    expect(() => tools.run(b, null, 'task_set_status', { id: t.id, status: 'done' })).toThrow(/nicht gefunden/);
    expect(() => tools.run(b, null, 'task_create', { title: 'x', milestoneId: m.id })).toThrow(/nicht gefunden/);
    expect(() => tools.run(b, null, 'note_update', { id: note.id, body: 'x' })).toThrow(/nicht gefunden/);
    expect(tools.run(b, null, 'tasks_list', {})).toEqual([]);
  });

  it('manages subtasks and links the tasks to the chat session', () => {
    const p = project();
    const sid = `s-${p}`;
    db.insert('agent_sessions', { id: sid, project_id: p, agent_id: 'claude', transport: 'acp', title: 'Chat', status: 'idle', created_at: nowIso(), updated_at: nowIso() });
    const t = tools.run(p, sid, 'task_create', { title: 'Login', subtasks: ['Formular', 'API'] }) as { id: string; subtasks: { id: string; title: string; done: boolean }[] };
    expect(t.subtasks.map((s) => [s.title, s.done])).toEqual([['Formular', false], ['API', false]]);
    // a todo task is not yet linked to the chat
    expect(repo.sessionTaskIds(sid)).toEqual([]);

    const added = tools.run(p, sid, 'subtasks_add', { taskId: t.id, titles: ['Tests'] }) as { subtasks: { id: string; title: string }[] };
    expect(added.subtasks.map((s) => s.title)).toEqual(['Formular', 'API', 'Tests']);
    expect(repo.sessionTaskIds(sid)).toEqual([t.id]);

    const upd = tools.run(p, sid, 'subtask_update', { id: added.subtasks[0]!.id, done: true }) as Obj;
    expect(upd).toMatchObject({ taskId: t.id, subtasksDone: '1/3' });
    expect(tools.run(p, sid, 'tasks_list', {})).toEqual([expect.objectContaining({ subtasksDone: '1/3' })]);
    expect(tools.run(p, sid, 'current_task', {})).toMatchObject({ tasks: [expect.objectContaining({ id: t.id })] });
    // task details carry the subtask ids plus a hint to tick them off
    expect(tools.run(p, sid, 'task_get', { id: t.id })).toMatchObject({
      subtasks: [{ title: 'Formular', done: true }, { title: 'API', done: false }, { title: 'Tests', done: false }],
      subtasksHint: expect.stringContaining('subtask_update'),
    });

    const other = project();
    expect(() => tools.run(other, null, 'subtask_update', { id: added.subtasks[1]!.id, done: true })).toThrow(/nicht gefunden/);

    const t2 = tools.run(p, sid, 'task_create', { title: 'Logout' }) as Obj;
    tools.run(p, sid, 'task_set_status', { id: t2.id, status: 'in_progress' });
    expect(repo.sessionTaskIds(sid)).toEqual([t.id, t2.id]);
  });

  it('rejects unknown tools and reports no current task outside task runs', () => {
    const p = project();
    expect(() => tools.run(p, null, 'rm_rf', {})).toThrow(/Unbekanntes Tool/);
    expect(tools.run(p, 'some-session', 'current_task', {})).toMatch(/keiner Aufgabe/);
  });
});
