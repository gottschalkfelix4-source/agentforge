import { afterAll, describe, expect, it } from 'vitest';
import type { AgentSession, GhIssue, WsdMethod } from '@vibe/shared';
import { Db, nowIso } from '../db/index.js';
import { GitHubClient, type FetchFn } from '../github/client.js';
import { isValidRank, planMove, rankAtEnd, rankBetween, rankSequence } from './rank.js';
import { PmRepo } from './repo.js';
import { AgentTools } from './agent-tools.js';
import { buildTaskPrompt, prBody, slugify, TaskRunService, type RunDeps, type WsdLike } from './runs.js';
import { columnFromIssue, decide, issuePayloadFromTask, PmSync, taskFieldsFromIssue } from './sync.js';

const db = new Db(':memory:');
const repo = new PmRepo(db);
afterAll(() => db.close());

let pn = 0;
function project(linked = false) {
  const id = `p${++pn}`;
  db.insert('projects', { id, name: id, slug: id, git_url: null, default_branch: null, created_at: nowIso(), archived: 0 });
  if (linked) db.run("UPDATE projects SET repo_owner = 'o', repo_name = 'r' WHERE id = ?", id);
  return id;
}

// ---- rank -----------------------------------------------------------------------------------

describe('rank', () => {
  it('generates keys strictly between neighbours', () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const c = rankBetween(null, a);
    expect(c < a && a < b).toBe(true);
    const m = rankBetween(a, b);
    expect(a < m && m < b).toBe(true);
    expect(() => rankBetween(b, a)).toThrow();
  });

  it('keeps inserting at the front / between the same pair', () => {
    let first = rankBetween(null, null);
    for (let i = 0; i < 200; i++) {
      const n = rankBetween(null, first);
      expect(n < first && isValidRank(n)).toBe(true);
      first = n;
    }
    let lo = 'a';
    const hi = 'b';
    for (let i = 0; i < 200; i++) {
      const n = rankBetween(lo, hi);
      expect(lo < n && n < hi && isValidRank(n)).toBe(true);
      lo = n;
    }
  });

  it('sequences are sorted', () => {
    const s = rankSequence(100);
    expect([...s].sort()).toEqual(s);
    expect(new Set(s).size).toBe(100);
  });

  it('plans moves using the before neighbour, falls back to after / end', () => {
    const col = [
      { id: 'a', rank: 'a' },
      { id: 'b', rank: 'b' },
      { id: 'c', rank: 'c' },
    ];
    const between = planMove(col, 'x', 'a', 'b').rank;
    expect(between > 'a' && between < 'b').toBe(true);
    // stale afterId is ignored when beforeId is known
    const stale = planMove(col, 'x', 'b', 'a').rank;
    expect(stale > 'b' && stale < 'c').toBe(true);
    const top = planMove(col, 'x', null, 'a').rank;
    expect(top < 'a').toBe(true);
    expect(planMove(col, 'x').rank > 'c').toBe(true);
    // moving within the same column ignores the task's own rank
    const self = planMove(col, 'a', 'c', null).rank;
    expect(self > 'c').toBe(true);
    expect(rankAtEnd(col) > 'c').toBe(true);
  });

  it('rebalances duplicate ranks', () => {
    const plan = planMove(
      [
        { id: 'a', rank: 'V' },
        { id: 'b', rank: 'V' },
      ],
      'x',
      'a',
      'b',
    );
    expect(plan.rebalance).toBeDefined();
    const r = plan.rebalance!;
    expect(r.get('a')! < r.get('x')! && r.get('x')! < r.get('b')!).toBe(true);
  });

  it('moves tasks in the DB', () => {
    const pid = project();
    const t1 = repo.createTask(pid, { title: 'eins', column: 'todo' });
    const t2 = repo.createTask(pid, { title: 'zwei', column: 'todo' });
    const t3 = repo.createTask(pid, { title: 'drei', column: 'backlog' });
    expect(t1.rank < t2.rank).toBe(true);
    repo.moveTask(t3.id, 'todo', t1.id, t2.id);
    const order = repo.tasks(pid).filter((t) => t.column === 'todo').map((t) => t.title);
    expect(order).toEqual(['eins', 'drei', 'zwei']);
    repo.moveTask(t2.id, 'todo', null, t1.id);
    expect(repo.tasks(pid).filter((t) => t.column === 'todo').map((t) => t.title)).toEqual(['zwei', 'eins', 'drei']);
  });
});

// ---- sync mapping ------------------------------------------------------------------------------

const issue = (over: Partial<GhIssue> = {}): GhIssue => ({
  number: 7,
  title: 'Login bauen',
  body: 'Text',
  state: 'open',
  labels: [],
  milestone: null,
  author: 'me',
  htmlUrl: 'https://github.com/o/r/issues/7',
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-02T10:00:00Z',
  isPull: false,
  ...over,
});

describe('issue ↔ task mapping', () => {
  it('maps state and status labels to columns', () => {
    expect(columnFromIssue(issue({ state: 'closed' }), 'todo')).toBe('done');
    expect(columnFromIssue(issue({ labels: [{ name: 'status:review', color: 'x' }] }), 'todo')).toBe('review');
    expect(columnFromIssue(issue({ labels: [{ name: 'Status:In_Progress', color: 'x' }] }), null)).toBe('in_progress');
    expect(columnFromIssue(issue(), null)).toBe('backlog');
    expect(columnFromIssue(issue(), 'review')).toBe('review');
    expect(columnFromIssue(issue(), 'done')).toBe('todo'); // reopened
    expect(columnFromIssue(issue({ labels: [{ name: 'status:done', color: 'x' }] }), 'todo')).toBe('todo');
  });

  it('separates status labels from normal labels', () => {
    const f = taskFieldsFromIssue(
      issue({ labels: [{ name: 'bug', color: 'ff0000' }, { name: 'status:todo', color: 'x' }], milestone: { number: 3, title: 'v1' } }),
      null,
    );
    expect(f).toMatchObject({ title: 'Login bauen', column: 'todo', milestoneNumber: 3, labels: [{ name: 'bug', color: 'ff0000' }] });
  });

  it('builds issue payloads', () => {
    expect(issuePayloadFromTask({ title: 'T', body: 'B', column: 'done' }, ['bug', 'status:todo'], 2)).toEqual({
      title: 'T',
      body: 'B',
      state: 'closed',
      labels: ['bug', 'status:done'],
      milestone: 2,
    });
  });

  it('decides with last-writer-wins', () => {
    const base = '2026-09-02T10:00:00Z';
    expect(decide({ updatedAt: base, ghUpdatedAt: base }, base)).toBe('none');
    expect(decide({ updatedAt: base, ghUpdatedAt: base }, '2026-09-02T11:00:00Z')).toBe('pull');
    expect(decide({ updatedAt: '2026-09-02T10:30:00.000Z', ghUpdatedAt: base }, base)).toBe('push');
    expect(decide({ updatedAt: '2026-09-02T10:30:00.000Z', ghUpdatedAt: base }, '2026-09-02T11:00:00Z')).toBe('conflict_pull');
    expect(decide({ updatedAt: '2026-09-02T12:00:00.000Z', ghUpdatedAt: base }, '2026-09-02T11:00:00Z')).toBe('conflict_push');
    // format differences (ms vs no ms) must not count as a change
    expect(decide({ updatedAt: '2026-09-02T10:00:00.000Z', ghUpdatedAt: base }, base)).toBe('none');
  });
});

describe('sync engine', () => {
  it('pulls issues, pushes local tasks and resolves conflicts', async () => {
    const pid = project(true);
    const local = repo.createTask(pid, { title: 'Lokal', column: 'todo' });
    const remoteIssues = [
      { number: 1, title: 'Remote', body: 'b', state: 'open', labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'status:review' }], milestone: null, user: { login: 'x' }, html_url: 'https://github.com/o/r/issues/1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
    ];
    const calls: string[] = [];
    let next = 10;
    const fetchFn: FetchFn = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.pathname}`);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json', etag: '"e1"' } });
      if (url.pathname.endsWith('/milestones') && method === 'GET') return json([]);
      if (url.pathname.endsWith('/issues') && method === 'GET') return json(remoteIssues);
      if (url.pathname.endsWith('/issues') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { title: string; labels: string[] };
        return json({ number: next++, title: body.title, body: '', state: 'open', labels: body.labels, milestone: null, user: null, html_url: 'u', created_at: 'x', updated_at: '2026-09-03T00:00:00Z' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const client = new GitHubClient('t', fetchFn);
    const sync = new PmSync(db, repo, { repoOf: () => ({ owner: 'o', name: 'r' }), client: () => client });
    const res = await sync.sync(pid);
    expect(res).toMatchObject({ ok: true, pulled: 1, pushed: 1 });
    const tasks = repo.tasks(pid);
    const pulled = tasks.find((t) => t.ghIssueNumber === 1)!;
    expect(pulled).toMatchObject({ title: 'Remote', column: 'review' });
    expect(pulled.labels.map((l) => l.name)).toEqual(['bug']);
    expect(tasks.find((t) => t.id === local.id)!.ghIssueNumber).toBe(10);
    expect(calls).toContain('POST /repos/o/r/issues');
    expect(repo.syncLog(pid).length).toBe(2);

    // Remote edit newer than a local edit → GitHub wins (conflict logged).
    db.run("UPDATE tasks SET title = 'Lokal geändert', updated_at = '2026-09-04T00:00:00.000Z' WHERE id = ?", pulled.id);
    remoteIssues[0] = { ...remoteIssues[0]!, title: 'Remote neu', state: 'closed', updated_at: '2026-09-05T00:00:00Z' };
    const res2 = await sync.sync(pid);
    expect(res2.conflicts).toBe(1);
    expect(repo.task(pulled.id)).toMatchObject({ title: 'Remote neu', column: 'done' });
    expect(sync.settings(pid)).toMatchObject({ syncEnabled: true, syncCreateIssues: true, linked: true, lastSync: { ok: true } });
  });
});

// ---- runs ------------------------------------------------------------------------------------

function fakeWsd(opts: { isRepo?: boolean; dirty?: boolean } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  let head = 'base0';
  let dirty = opts.dirty ?? true;
  let commits = 0;
  const client: WsdLike = {
    call: (async (method: WsdMethod, params: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case 'git.status':
          return { isRepo: opts.isRepo ?? true, branch: 'main', upstream: null, ahead: 0, behind: 0, files: dirty ? [{ path: 'a.ts', index: '?', worktree: '?' }] : [] };
        case 'git.log':
          return [{ sha: head, shortSha: head, author: '', email: '', date: '', subject: '' }];
        case 'git.worktree.list':
          return [{ path: '.', branch: 'refs/heads/main', head: 'base0' }];
        case 'git.worktree.add': {
          const p = params as { path: string; branch: string };
          return { path: p.path, branch: p.branch, head: 'base0' };
        }
        case 'git.commit':
          head = `c${++commits}`;
          dirty = false;
          return { sha: head };
        default:
          return { ok: true, output: '' };
      }
    }) as WsdLike['call'],
  };
  return { client, calls, setDirty: (d: boolean) => (dirty = d) };
}

let sn = 0;
function runDeps(client: WsdLike, linked = true, opts: { failPrompt?: boolean } = {}) {
  const prompts: string[] = [];
  const pulls: unknown[] = [];
  let pullState: 'open' | 'closed' | 'merged' = 'open';
  const deps: RunDeps = {
    repo,
    wsd: async () => client,
    connectedWsd: () => client,
    sessions: {
      create: async (projectId, req) => {
        const id = `s${++sn}`;
        const now = nowIso();
        db.insert('agent_sessions', {
          id, project_id: projectId, agent_id: req.agentId, profile_id: null, transport: 'codex_app_server', title: req.title ?? '',
          status: 'starting', status_message: null, external_id: null, cwd: req.cwd ?? '.', task_run_id: null,
          current_model: null, current_mode: null, last_seq: 0, created_at: now, updated_at: now,
        });
        return { id, projectId, status: 'starting', cwd: req.cwd } as unknown as AgentSession;
      },
      prompt: async (_sid, text) => {
        if (opts.failPrompt) throw new Error('agent not reachable');
        return prompts.push(text);
      },
      stop: async () => ({}),
      link: () => {},
    },
    github: {
      repoOf: () => (linked ? { owner: 'o', name: 'r' } : null),
      connected: () => true,
      createPull: async (_pid, input) => {
        pulls.push(input);
        return { number: 42, htmlUrl: 'https://github.com/o/r/pull/42' } as never;
      },
      pullState: async () => pullState,
    },
  };
  return { deps, prompts, pulls, setPullState: (s: typeof pullState) => (pullState = s) };
}

describe('task runs', () => {
  const tools = new AgentTools(repo);

  it('builds prompts, slugs and PR bodies', () => {
    expect(slugify('Größe ändern & testen!')).toBe('groesse-aendern-testen');
    const base = { taskId: 't1', title: 'T', body: 'B', labels: ['bug'], milestone: { title: 'v1', dueOn: '2026-10-01' }, issue: { number: 3, url: null }, worktreePath: '.worktrees/task-x', branch: 'vibe/x' };
    const p = buildTaskPrompt({ ...base, subtasks: [{ id: 's1', title: 'Formular', done: true }, { id: 's2', title: 'API', done: false }] });
    expect(p).toContain('# T');
    // The checklist is part of the prompt (with ids), so the agent ticks it off instead of keeping its own list.
    expect(p).toContain('- [x] Formular (id: `s1`)');
    expect(p).toContain('- [ ] API (id: `s2`)');
    expect(p).toContain('subtask_update');
    expect(buildTaskPrompt({ ...base, subtasks: [] })).toContain('subtasks_add` (Aufgaben-ID `t1`)');
    expect(p).toContain('Labels: bug');
    expect(p).toContain('/workspace/.worktrees/task-x');
    expect(prBody({ title: 'T', body: 'B', gh_issue_number: 3 }, { agent_id: 'codex', branch: 'b' })).toContain('Closes #3');
  });

  it('refuses to run without a git repo', async () => {
    const pid = project();
    const t = repo.createTask(pid, { title: 'X' });
    const svc = new TaskRunService(runDeps(fakeWsd({ isRepo: false }).client).deps);
    await expect(svc.start(t.id, { agentId: 'codex' })).rejects.toThrow(/Git initialisieren|initialisiere zuerst Git/);
  });

  it('starts, auto-finishes with a PR and completes on merge', async () => {
    const pid = project(true);
    const t = repo.createTask(pid, { title: 'Dark Mode einbauen', column: 'todo' });
    db.run('UPDATE tasks SET gh_issue_number = 5 WHERE id = ?', t.id);
    const { client, calls } = fakeWsd();
    const { deps, prompts, pulls, setPullState } = runDeps(client);
    const svc = new TaskRunService(deps);

    const run = await svc.start(t.id, { agentId: 'codex', autoPr: true });
    const short = t.id.slice(-6).toLowerCase();
    expect(run).toMatchObject({ status: 'running', worktreePath: `.worktrees/task-${short}`, branch: `vibe/task-${short}-dark-mode-einbauen` });
    expect(calls.find((c) => c.method === 'git.worktree.add')!.params).toMatchObject({ base: 'main' });
    expect(prompts[0]).toContain('Dark Mode einbauen');
    expect(repo.taskRow(t.id).col).toBe('in_progress');
    expect(prompts[0]).toContain('task_done');

    // A turn that ends without the done signal (e.g. a question to the user) commits nothing.
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    expect(repo.runRow(run.id).status).toBe('running');
    expect(calls.some((c) => c.method === 'git.commit' || c.method === 'git.push')).toBe(false);
    expect(pulls).toHaveLength(0);
    expect(repo.taskRow(t.id).col).toBe('in_progress');

    tools.run(pid, run.sessionId!, 'task_done', {});
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    const done = repo.runRow(run.id);
    expect(done.agent_done).toBe(0); // consumed
    expect(done).toMatchObject({ status: 'pr_open', pr_number: 42 });
    expect(calls.map((c) => c.method)).toEqual(expect.arrayContaining(['git.stage', 'git.commit', 'git.push']));
    expect(pulls[0]).toMatchObject({ head: run.branch, base: 'main', title: 'Dark Mode einbauen' });
    expect((pulls[0] as { body: string }).body).toContain('Closes #5');
    expect(repo.taskRow(t.id).col).toBe('review');

    setPullState('merged');
    expect(await svc.checkPullRequests(pid)).toBe(1);
    expect(repo.runRow(run.id).status).toBe('merged');
    expect(repo.taskRow(t.id).col).toBe('done');
    expect(calls.at(-1)).toMatchObject({ method: 'git.worktree.remove', params: { path: run.worktreePath, force: true } });
  });

  it('auto flow without changes → awaiting_review with the task in review; cancel moves the task back', async () => {
    const pid = project(false);
    const t = repo.createTask(pid, { title: 'Nichts tun', column: 'todo' });
    const { client, calls } = fakeWsd({ dirty: false });
    const svc = new TaskRunService(runDeps(client, false).deps);
    const run = await svc.start(t.id, { agentId: 'codex', autoPr: true });
    await expect(svc.start(t.id, { agentId: 'codex' })).rejects.toThrow(/bereits/);
    tools.run(pid, run.sessionId!, 'task_done', {});
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    expect(repo.runRow(run.id).status).toBe('awaiting_review');
    // run and task agree: the agent's result (no changes) awaits the user's review
    expect(repo.taskRow(t.id).col).toBe('review');
    await expect(svc.finish(run.id)).rejects.toThrow(/Keine Änderungen/);
    const c = await svc.cancel(run.id, { removeWorktree: true });
    expect(c.status).toBe('cancelled');
    expect(calls.at(-1)!.method).toBe('git.worktree.remove');
    expect(repo.taskRow(t.id).col).toBe('todo');
  });

  it('only auto-finishes after the agent declared the task done', async () => {
    const pid = project(false);
    const t = repo.createTask(pid, { title: 'Rückfrage', column: 'todo' });
    const { client, calls } = fakeWsd();
    const svc = new TaskRunService(runDeps(client, false).deps);
    const run = await svc.start(t.id, { agentId: 'codex', autoPr: true });
    // The agent asks a question and ends its turn: nothing is committed, the run stays open.
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    expect(repo.runRow(run.id).status).toBe('running');
    expect(calls.some((c) => c.method === 'git.commit')).toBe(false);
    // Moving its own task to review is the same signal (works with workspace images that lack task_done).
    tools.run(pid, run.sessionId!, 'task_set_status', { id: t.id, status: 'review' });
    expect(repo.runRow(run.id).agent_done).toBe(1);
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    expect(repo.runRow(run.id)).toMatchObject({ status: 'awaiting_review', agent_done: 0 });
    expect(calls.some((c) => c.method === 'git.commit')).toBe(true);
    // Moving another task does not count; task_done outside a task run is refused.
    const other = repo.createTask(pid, { title: 'Andere' });
    tools.run(pid, run.sessionId!, 'task_set_status', { id: other.id, status: 'review' });
    expect(repo.runRow(run.id).agent_done).toBe(0);
    expect(() => tools.run(pid, null, 'task_done', {})).toThrow(/keinem offenen Agent-Lauf/);
  });

  it('syncs follow-up turns of runs awaiting review or with an open PR', async () => {
    const pid = project(true);
    const t = repo.createTask(pid, { title: 'Nachbessern', column: 'todo' });
    const { client, calls, setDirty } = fakeWsd({ dirty: false });
    const { deps, pulls } = runDeps(client);
    const svc = new TaskRunService(deps);
    const run = await svc.start(t.id, { agentId: 'codex', autoPr: true });
    const sid = run.sessionId!;
    const turn = async (done: boolean) => {
      if (done) tools.run(pid, sid, 'task_done', {});
      await svc.onAgentEvent(sid, { type: 'turn.done', stopReason: 'end_turn' });
    };

    // First turn without changes → awaiting_review, no PR.
    await turn(true);
    expect(repo.runRow(run.id).status).toBe('awaiting_review');
    expect(pulls).toHaveLength(0);

    // Follow-up with changes: a question first (nothing happens), then done → commit, push, PR.
    setDirty(true);
    await turn(false);
    expect(calls.some((c) => c.method === 'git.commit')).toBe(false);
    await turn(true);
    expect(repo.runRow(run.id)).toMatchObject({ status: 'pr_open', pr_number: 42 });
    expect(pulls).toHaveLength(1);

    // Review fixes after the PR is open: pushed into the same PR, no second PR.
    setDirty(true);
    const pushes = () => calls.filter((c) => c.method === 'git.push').length;
    const before = pushes();
    await turn(true);
    expect(pushes()).toBe(before + 1);
    expect(calls.filter((c) => c.method === 'git.commit')).toHaveLength(2);
    expect(pulls).toHaveLength(1);
    expect(repo.runRow(run.id).status).toBe('pr_open');

    // A failed follow-up turn keeps the PR tracked (merge detection only looks at pr_open runs).
    await svc.onAgentEvent(sid, { type: 'turn.done', stopReason: 'error' });
    expect(repo.runRow(run.id).status).toBe('pr_open');
  });

  it('marks runs failed when the turn ends with an error', async () => {
    const pid = project(false);
    const t = repo.createTask(pid, { title: 'Fehler' });
    const svc = new TaskRunService(runDeps(fakeWsd().client, false).deps);
    const run = await svc.start(t.id, { agentId: 'codex', autoPr: true });
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'error' });
    expect(repo.runRow(run.id).status).toBe('failed');
    // a later successful turn (after re-prompting) is being worked on again …
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    expect(repo.runRow(run.id).status).toBe('running');
    // … and still triggers the auto flow once the agent is done
    tools.run(pid, run.sessionId!, 'task_done', {});
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    expect(repo.runRow(run.id).status).toBe('awaiting_review');
  });

  it('does not create two runs when started twice at once', async () => {
    const pid = project(false);
    const t = repo.createTask(pid, { title: 'Doppelklick', column: 'todo' });
    const { client, calls } = fakeWsd();
    const svc = new TaskRunService(runDeps(client, false).deps);
    const results = await Promise.allSettled([svc.start(t.id, { agentId: 'codex' }), svc.start(t.id, { agentId: 'codex' })]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect(calls.filter((c) => c.method === 'git.worktree.add')).toHaveLength(1);
    expect(repo.runs(t.id)).toHaveLength(1);
    // the guard is released afterwards (the regular busy check applies again)
    await expect(svc.start(t.id, { agentId: 'codex' })).rejects.toThrow(/bereits/);
  });

  it('leaves the task where it was when the prompt fails', async () => {
    const pid = project(false);
    const t = repo.createTask(pid, { title: 'Kein Agent', column: 'todo' });
    const svc = new TaskRunService(runDeps(fakeWsd().client, false, { failPrompt: true }).deps);
    const run = await svc.start(t.id, { agentId: 'codex' });
    expect(run.status).toBe('failed');
    expect(repo.taskRow(t.id).col).toBe('todo');
  });

  it('closes runs of PRs closed without merge: task back to todo, worktree removed', async () => {
    const pid = project(true);
    const t = repo.createTask(pid, { title: 'Verworfen', column: 'todo' });
    const { client, calls } = fakeWsd();
    const { deps, setPullState } = runDeps(client);
    const svc = new TaskRunService(deps);
    const run = await svc.start(t.id, { agentId: 'codex', autoPr: true });
    tools.run(pid, run.sessionId!, 'task_done', {});
    await svc.onAgentEvent(run.sessionId!, { type: 'turn.done', stopReason: 'end_turn' });
    expect(repo.taskRow(t.id).col).toBe('review');

    setPullState('closed');
    expect(await svc.checkPullRequests(pid)).toBe(1);
    expect(repo.runRow(run.id).status).toBe('cancelled');
    expect(repo.taskRow(t.id).col).toBe('todo');
    // without force: uncommitted changes keep the worktree; the pushed branch survives either way
    expect(calls.at(-1)).toEqual({ method: 'git.worktree.remove', params: { path: run.worktreePath } });
  });

  it('lets the user move a task to another column only with an explicit force override', () => {
    const pid = project();
    const a = repo.createTask(pid, { title: 'A', column: 'todo' });
    const b = repo.createTask(pid, { title: 'B', column: 'todo' });
    expect(() => repo.userMoveTask(a.id, { column: 'done' })).toThrow(/nur der Agent/);
    expect(repo.userMoveTask(a.id, { column: 'todo', afterId: b.id }).col).toBe('todo'); // reorder is fine
    expect(repo.userMoveTask(a.id, { column: 'done', force: true }).col).toBe('done');
  });

  it('finishes without a linked repo by committing only', async () => {
    const pid = project(false);
    const t = repo.createTask(pid, { title: 'Lokal' });
    const { client, calls } = fakeWsd();
    const { deps, pulls } = runDeps(client, false);
    const svc = new TaskRunService(deps);
    const run = await svc.start(t.id, { agentId: 'codex' });
    const fin = await svc.finish(run.id);
    expect(fin.status).toBe('awaiting_review');
    expect(pulls).toHaveLength(0);
    expect(calls.some((c) => c.method === 'git.push')).toBe(false);
    expect(repo.taskRow(t.id).col).toBe('review');
  });
});
