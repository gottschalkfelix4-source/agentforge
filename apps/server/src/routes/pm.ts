import type { FastifyInstance } from 'fastify';
import { TASK_COLUMNS, type WsdNotifications } from '@vibe/shared';
import { z, ZodError } from 'zod';
import type { AppContext } from '../app-context.js';
import { bus } from '../events.js';
import type { RawPull } from '../github/mappers.js';
import { githubService } from '../github/service.js';
import { PmRepo, publishPm, toNote } from '../pm/repo.js';
import { AgentTools } from '../pm/agent-tools.js';
import { TaskRunService, type WsdLike } from '../pm/runs.js';
import { PmSync } from '../pm/sync.js';
import { SessionService, toSession, type SessionRow } from '../sessions/service.js';
import { HttpError } from '../workspaces/manager.js';

// Phase 5 – project management: tasks (kanban), labels, milestones, notes, agent task runs, GitHub issue sync.

const column = z.enum(TASK_COLUMNS);
const color = z
  .string()
  .trim()
  .transform((s) => s.replace(/^#/, ''))
  .pipe(z.string().regex(/^[0-9a-fA-F]{6}$/, 'Farbe als Hex (z. B. 3b82f6)'));
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Datum im Format JJJJ-MM-TT')
  .transform((s) => s.slice(0, 10));

const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(100_000).optional(),
  column: column.optional(),
  milestoneId: z.string().nullish(),
  labelIds: z.array(z.string()).max(50).optional(),
  assigneeProfileId: z.string().nullish(),
});
const moveInput = z.object({ column, beforeId: z.string().nullish(), afterId: z.string().nullish() });
const labelInput = z.object({ name: z.string().trim().min(1).max(50), color: color.optional() });
const milestoneInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  dueOn: date.nullish(),
  state: z.enum(['open', 'closed']).optional(),
});
const noteInput = z.object({ title: z.string().trim().max(200).optional(), body: z.string().max(500_000).optional(), pinned: z.boolean().optional() });
const runInput = z.object({ agentId: z.string().min(1), profileId: z.string().nullish(), autoPr: z.boolean().optional() });
const settingsInput = z.object({ syncEnabled: z.boolean().optional(), syncCreateIssues: z.boolean().optional() });
const subtaskTitle = z.string().trim().min(1).max(300);
const subtasksInput = z.union([z.object({ title: subtaskTitle }), z.object({ titles: z.array(subtaskTitle).min(1).max(50) })]);
const subtaskPatch = z.object({ title: subtaskTitle.optional(), done: z.boolean().optional() });

type P = { Params: { id: string } };

export async function pmRoutes(app: FastifyInstance, ctx: AppContext) {
  const repo = new PmRepo(ctx.db);
  const gh = githubService(ctx);
  const log = { info: (m: string) => app.log.info(m), warn: (m: string) => app.log.warn(m) };
  const sessions = new SessionService(ctx, log);

  const runs = new TaskRunService({
    repo,
    wsd: (projectId) => ctx.workspaces.waitForClient(projectId, 5_000) as Promise<WsdLike>,
    connectedWsd: (projectId) => {
      try {
        return ctx.workspaces.client(projectId) as WsdLike;
      } catch {
        return null;
      }
    },
    sessions: {
      create: (projectId, req) => sessions.create(projectId, req),
      prompt: (sid, text) => sessions.prompt(sid, text),
      stop: (sid) => sessions.stop(sid),
      link: (sid, runId) => {
        ctx.db.run('UPDATE agent_sessions SET task_run_id = ? WHERE id = ?', runId, sid);
        const row = ctx.db.get<SessionRow>('SELECT * FROM agent_sessions WHERE id = ?', sid);
        if (row) bus.project(row.project_id, { type: 'session.updated', projectId: row.project_id, session: toSession(row) });
      },
    },
    github: {
      repoOf: (projectId) => gh.repoOf(projectId),
      connected: () => !!gh.getToken(),
      createPull: (projectId, input) => gh.createPull(projectId, input),
      pullState: async (projectId, n) => {
        const r = gh.requireRepo(projectId);
        const pr = await gh.api().get<RawPull>(`${r.base}/pulls/${n}`);
        return pr.merged || pr.merged_at ? 'merged' : pr.state;
      },
    },
    log,
  });

  const sync = new PmSync(ctx.db, repo, { repoOf: (id) => gh.repoOf(id), client: () => (gh.getToken() ? gh.api() : null) }, (m) => app.log.warn(m));

  // Auto-PR on turn.done (the sessions module persists the same notification independently).
  ctx.workspaces.onWsdNotification((_projectId, method, params) => {
    if (method !== 'agent.event') return;
    const p = params as WsdNotifications['agent.event'];
    // Let the sessions module ingest the event first.
    setImmediate(() => void runs.onAgentEvent(p.sessionId, p.event));
  });
  bus.subscribe((_ch, e) => {
    if (e.type === 'github.changed') runs.scheduleCheck(e.projectId);
  });
  const prTimer = setInterval(() => void runs.checkPullRequests().catch(() => undefined), 2 * 60_000);
  prTimer.unref();
  sync.start();
  app.addHook('onClose', async () => {
    clearInterval(prTimer);
    sync.stop();
  });

  const projectOfTask = (tid: string) => repo.taskRow(tid).project_id;

  // ---- Agentforge tools for agents (agentforge-mcp → wsd /app-call → app.request) -----------------
  const agentTools = new AgentTools(repo);
  ctx.workspaces.onWsdNotification((projectId, method, params) => {
    if (method !== 'app.request') return;
    const r = params as WsdNotifications['app.request'];
    // Only sessions of this project may claim a task context.
    const sessionId =
      r.sessionId && ctx.db.get('SELECT id FROM agent_sessions WHERE id = ? AND project_id = ?', r.sessionId, projectId) ? r.sessionId : null;
    let reply: { result?: unknown; error?: string };
    try {
      reply = { result: agentTools.run(projectId, sessionId, r.method, r.params) };
    } catch (err) {
      reply = {
        error:
          err instanceof ZodError
            ? `Ungültige Parameter: ${err.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`
            : (err as Error).message,
      };
    }
    try {
      void ctx.workspaces.client(projectId).call('app.respond', { id: r.id, ...reply }).catch(() => undefined);
    } catch {
      /* workspace disconnected meanwhile — the tool call times out on its side */
    }
  });

  // ---- tasks ---------------------------------------------------------------------------------

  app.get<P>('/api/projects/:id/tasks', async (req) => {
    repo.projectExists(req.params.id);
    return repo.tasks(req.params.id);
  });

  app.post<P>('/api/projects/:id/tasks', async (req) => {
    const t = repo.createTask(req.params.id, taskInput.parse(req.body));
    publishPm(req.params.id, 'task');
    return repo.task(t.id);
  });

  app.patch<{ Params: { tid: string } }>('/api/tasks/:tid', async (req) => {
    const t = repo.updateTask(req.params.tid, taskInput.partial().parse(req.body));
    publishPm(t.project_id, 'task');
    return repo.task(t.id);
  });

  app.delete<{ Params: { tid: string } }>('/api/tasks/:tid', async (req) => {
    const t = repo.deleteTask(req.params.tid);
    publishPm(t.project_id, 'task');
    return { ok: true };
  });

  app.post<{ Params: { tid: string } }>('/api/tasks/:tid/move', async (req) => {
    const body = moveInput.parse(req.body);
    const t = repo.moveTask(req.params.tid, body.column, body.beforeId, body.afterId);
    publishPm(t.project_id, 'task');
    return repo.task(t.id);
  });

  // ---- subtasks (checklist of a task) ---------------------------------------------------------------

  app.post<{ Params: { tid: string } }>('/api/tasks/:tid/subtasks', async (req) => {
    const b = subtasksInput.parse(req.body);
    const pid = projectOfTask(req.params.tid);
    repo.addSubtasks(req.params.tid, 'titles' in b ? b.titles : [b.title]);
    publishPm(pid, 'task');
    return repo.task(req.params.tid);
  });

  app.post<{ Params: { tid: string } }>('/api/tasks/:tid/subtasks/order', async (req) => {
    const pid = projectOfTask(req.params.tid);
    repo.reorderSubtasks(req.params.tid, z.object({ ids: z.array(z.string()).max(500) }).parse(req.body).ids);
    publishPm(pid, 'task');
    return repo.task(req.params.tid);
  });

  app.patch<{ Params: { sid: string } }>('/api/subtasks/:sid', async (req) => {
    const s = repo.updateSubtask(req.params.sid, subtaskPatch.parse(req.body));
    publishPm(projectOfTask(s.task_id), 'task');
    return repo.task(s.task_id);
  });

  app.delete<{ Params: { sid: string } }>('/api/subtasks/:sid', async (req) => {
    const s = repo.deleteSubtask(req.params.sid);
    publishPm(projectOfTask(s.task_id), 'task');
    return repo.task(s.task_id);
  });

  // ---- board tasks of a chat session (shown in the chat's todo bar) -------------------------------

  const sessionProject = (sid: string) => {
    const r = ctx.db.get<{ project_id: string }>('SELECT project_id FROM agent_sessions WHERE id = ?', sid);
    if (!r) throw new HttpError(404, 'not_found', 'Session nicht gefunden');
    return r.project_id;
  };

  app.get<{ Params: { sid: string } }>('/api/sessions/:sid/tasks', async (req) => {
    sessionProject(req.params.sid);
    return { taskIds: repo.sessionTaskIds(req.params.sid), runTaskId: repo.runBySession(req.params.sid)?.task_id ?? null };
  });

  app.put<{ Params: { sid: string; tid: string } }>('/api/sessions/:sid/tasks/:tid', async (req) => {
    const pid = sessionProject(req.params.sid);
    if (projectOfTask(req.params.tid) !== pid) throw new HttpError(400, 'invalid_task', 'Aufgabe gehört nicht zu diesem Projekt');
    repo.linkSessionTask(req.params.sid, req.params.tid);
    publishPm(pid, 'task');
    return { ok: true };
  });

  app.delete<{ Params: { sid: string; tid: string } }>('/api/sessions/:sid/tasks/:tid', async (req) => {
    const pid = sessionProject(req.params.sid);
    repo.unlinkSessionTask(req.params.sid, req.params.tid);
    publishPm(pid, 'task');
    return { ok: true };
  });

  // ---- labels ---------------------------------------------------------------------------------

  app.get<P>('/api/projects/:id/labels', async (req) => {
    repo.projectExists(req.params.id);
    return repo.labels(req.params.id);
  });

  app.post<P>('/api/projects/:id/labels', async (req) => {
    const body = labelInput.parse(req.body);
    const l = repo.createLabel(req.params.id, body.name, body.color);
    publishPm(req.params.id, 'label');
    return l;
  });

  app.patch<{ Params: { lid: string } }>('/api/labels/:lid', async (req) => {
    const l = repo.updateLabel(req.params.lid, labelInput.partial().parse(req.body));
    publishPm(l.projectId, 'label');
    publishPm(l.projectId, 'task');
    return l;
  });

  app.delete<{ Params: { lid: string } }>('/api/labels/:lid', async (req) => {
    const l = repo.deleteLabel(req.params.lid);
    publishPm(l.project_id, 'label');
    publishPm(l.project_id, 'task');
    return { ok: true };
  });

  // ---- milestones ---------------------------------------------------------------------------------

  app.get<P>('/api/projects/:id/milestones', async (req) => {
    repo.projectExists(req.params.id);
    return repo.milestones(req.params.id);
  });

  app.post<P>('/api/projects/:id/milestones', async (req) => {
    const m = repo.createMilestone(req.params.id, milestoneInput.parse(req.body));
    publishPm(req.params.id, 'milestone');
    return repo.milestone(m.id);
  });

  app.patch<{ Params: { mid: string } }>('/api/milestones/:mid', async (req) => {
    const b = milestoneInput.partial().parse(req.body);
    const m = repo.updateMilestone(req.params.mid, { title: b.title, description: b.description, due_on: b.dueOn, state: b.state });
    publishPm(m.project_id, 'milestone');
    return repo.milestone(m.id);
  });

  app.delete<{ Params: { mid: string } }>('/api/milestones/:mid', async (req) => {
    const m = repo.deleteMilestone(req.params.mid);
    publishPm(m.project_id, 'milestone');
    publishPm(m.project_id, 'task');
    return { ok: true };
  });

  // ---- notes ------------------------------------------------------------------------------------

  app.get<P>('/api/projects/:id/notes', async (req) => {
    repo.projectExists(req.params.id);
    return repo.notes(req.params.id);
  });

  app.post<P>('/api/projects/:id/notes', async (req) => {
    const n = repo.createNote(req.params.id, noteInput.parse(req.body ?? {}));
    publishPm(req.params.id, 'note');
    return n;
  });

  app.patch<{ Params: { nid: string } }>('/api/notes/:nid', async (req) => {
    const n = repo.updateNote(req.params.nid, noteInput.parse(req.body));
    publishPm(n.projectId, 'note');
    return n;
  });

  app.delete<{ Params: { nid: string } }>('/api/notes/:nid', async (req) => {
    const n = toNote(repo.deleteNote(req.params.nid));
    publishPm(n.projectId, 'note');
    return { ok: true };
  });

  // ---- task runs --------------------------------------------------------------------------------

  app.post<{ Params: { tid: string } }>('/api/tasks/:tid/run', async (req) => runs.start(req.params.tid, runInput.parse(req.body)));

  app.get<{ Params: { tid: string } }>('/api/tasks/:tid/runs', async (req) => {
    projectOfTask(req.params.tid);
    return repo.runs(req.params.tid);
  });

  app.post<{ Params: { rid: string } }>('/api/task-runs/:rid/finish', async (req) => runs.finish(req.params.rid));

  app.post<{ Params: { rid: string } }>('/api/task-runs/:rid/cancel', async (req) =>
    runs.cancel(req.params.rid, z.object({ removeWorktree: z.boolean().optional() }).parse(req.body ?? {})),
  );

  // ---- GitHub issue sync -----------------------------------------------------------------------

  app.post<P>('/api/projects/:id/github/sync', async (req) => {
    repo.projectExists(req.params.id);
    return sync.sync(req.params.id);
  });

  app.get<P>('/api/projects/:id/github/sync-log', async (req) => {
    repo.projectExists(req.params.id);
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse((req.query as { limit?: string }).limit);
    return repo.syncLog(req.params.id, limit);
  });

  app.get<P>('/api/projects/:id/pm-settings', async (req) => {
    repo.projectExists(req.params.id);
    return sync.settings(req.params.id);
  });

  app.put<P>('/api/projects/:id/pm-settings', async (req) => {
    repo.projectExists(req.params.id);
    return sync.setSettings(req.params.id, settingsInput.parse(req.body));
  });
}
