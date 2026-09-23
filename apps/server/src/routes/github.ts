import type { FastifyInstance } from 'fastify';
import type { GitHubDevicePoll } from '@vibe/shared';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { bus } from '../events.js';
import { githubService } from '../github/service.js';
import { HttpError } from '../workspaces/manager.js';

// Phase 3 – GitHub connection, repos, PRs/issues/checks and the project git routes (proxying wsd).

type P = { Params: { id: string } };
type PN = { Params: { id: string; n: string } };

const cwd = z.string().max(500).optional();
const paths = z.array(z.string().min(1).max(4096)).max(10_000);
const ghName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, 'Ungültiger Name');
const stateQuery = z.object({ state: z.enum(['open', 'closed', 'all']).default('open') });
const prNumber = (n: string) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, 'invalid_number', 'Ungültige Nummer');
  return v;
};

export async function githubRoutes(app: FastifyInstance, ctx: AppContext) {
  const gh = githubService(ctx);
  gh.start();
  const { db, workspaces } = ctx;

  const requireProject = (id: string) => {
    if (!db.get('SELECT id FROM projects WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Projekt nicht gefunden');
  };
  const wsd = async (id: string) => {
    requireProject(id);
    return workspaces.waitForClient(id, 5_000);
  };
  const changed = (id: string) => bus.project(id, { type: 'git.changed', projectId: id });

  // ---- connection ----------------------------------------------------------------

  app.get('/api/github/status', async () => gh.status());

  app.get('/api/github/client', async () => gh.clientIdInfo());

  app.put('/api/github/client', async (req) => {
    const body = z.object({ clientId: z.string().trim().max(100).nullable() }).parse(req.body);
    if (body.clientId && !/^[A-Za-z0-9._-]+$/.test(body.clientId)) throw new HttpError(400, 'invalid_client_id', 'Ungültige Client-ID');
    gh.setClientId(body.clientId || null);
    return gh.clientIdInfo();
  });

  app.post('/api/github/device/start', async () => {
    const clientId = gh.clientId();
    if (!clientId) {
      throw new HttpError(400, 'no_client_id', 'Keine OAuth Client-ID konfiguriert (GITHUB_CLIENT_ID oder in den Einstellungen)');
    }
    return gh.deviceFlow.start(clientId);
  });

  app.post('/api/github/device/poll', async (req): Promise<GitHubDevicePoll> => {
    const { handle } = z.object({ handle: z.string().min(1).max(100) }).parse(req.body);
    const r = await gh.deviceFlow.poll(handle);
    if (r.status === 'pending') return { status: 'pending' };
    if (r.status !== 'done') return { status: r.status, message: r.message };
    const s = await gh.connectWithToken(r.token, r.scopes);
    return { status: 'done', login: s.login };
  });

  app.post('/api/github/token', async (req) => {
    const { token } = z.object({ token: z.string().trim().min(10).max(500) }).parse(req.body);
    if (/\s/.test(token)) throw new HttpError(400, 'invalid_token', 'Token enthält Leerzeichen');
    await gh.connectWithToken(token);
    return gh.status();
  });

  app.delete('/api/github', async () => {
    await gh.disconnect();
    return { ok: true };
  });

  // ---- repos ---------------------------------------------------------------------------

  app.get('/api/github/repos', async (req) => {
    const q = z.object({ q: z.string().max(200).optional(), page: z.coerce.number().int().min(1).max(50).default(1) }).parse(req.query);
    return gh.listRepos(q.q, q.page);
  });

  app.post('/api/github/repos', async (req) => {
    const body = z
      .object({ name: ghName, private: z.boolean().default(true), description: z.string().max(350).nullish(), org: ghName.nullish() })
      .parse(req.body);
    return gh.createRepo(body);
  });

  /** Link a project to a repo: stores owner/name and points `origin` at it (if the workspace is a git repo). */
  app.post<P>('/api/projects/:id/github/link', async (req) => {
    requireProject(req.params.id);
    const body = z.object({ owner: ghName, name: ghName, setRemote: z.boolean().default(true) }).parse(req.body);
    const repo = await gh.getRepo(body.owner, body.name);
    db.update('projects', req.params.id, { repo_owner: repo.owner, repo_name: repo.name });
    const row = db.get<{ default_branch: string | null }>('SELECT default_branch FROM projects WHERE id = ?', req.params.id);
    if (!row?.default_branch) db.update('projects', req.params.id, { default_branch: repo.defaultBranch });
    let remoteSet = false;
    if (body.setRemote) {
      try {
        const client = workspaces.client(req.params.id);
        const st = await client.call('git.status', {});
        if (st.isRepo) {
          await client.call('git.remote.set', { name: 'origin', url: repo.cloneUrl });
          remoteSet = true;
        }
      } catch {
        /* workspace not running – remote can be set later */
      }
    }
    bus.publish('projects', { type: 'projects.changed' });
    bus.project(req.params.id, { type: 'github.changed', projectId: req.params.id });
    changed(req.params.id);
    return { repo, remoteSet };
  });

  // ---- project GitHub (linked repo) ----------------------------------------------------------

  app.get<P>('/api/projects/:id/github/pulls', async (req) => gh.listPulls(req.params.id, stateQuery.parse(req.query).state));

  app.post<P>('/api/projects/:id/github/pulls', async (req) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(256),
        body: z.string().max(65_000).optional(),
        head: z.string().trim().min(1).max(255),
        base: z.string().trim().max(255).optional(),
        draft: z.boolean().optional(),
      })
      .parse(req.body);
    return gh.createPull(req.params.id, body);
  });

  app.get<PN>('/api/projects/:id/github/pulls/:n', async (req) => gh.getPull(req.params.id, prNumber(req.params.n)));

  app.post<PN>('/api/projects/:id/github/pulls/:n/merge', async (req) => {
    const { method } = z.object({ method: z.enum(['merge', 'squash', 'rebase']).default('merge') }).parse(req.body ?? {});
    return gh.mergePull(req.params.id, prNumber(req.params.n), method);
  });

  app.get<P>('/api/projects/:id/github/issues', async (req) => gh.listIssues(req.params.id, { state: stateQuery.parse(req.query).state }));

  app.post<P>('/api/projects/:id/github/issues', async (req) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(256), body: z.string().max(65_000).optional(), labels: z.array(z.string().max(100)).max(50).optional() })
      .parse(req.body);
    return gh.upsertIssue(req.params.id, body);
  });

  app.get<P>('/api/projects/:id/github/checks', async (req) => {
    const { ref } = z.object({ ref: z.string().max(255).optional() }).parse(req.query);
    return gh.checks(req.params.id, ref);
  });

  // ---- project git (proxied to wsd) -------------------------------------------------------------

  app.get<P>('/api/projects/:id/git/status', async (req) => {
    const q = z.object({ cwd }).parse(req.query);
    return (await wsd(req.params.id)).call('git.status', q);
  });

  app.get<P>('/api/projects/:id/git/diff', async (req) => {
    const q = z
      .object({ cwd, path: z.string().max(4096).optional(), staged: z.enum(['1', '0', 'true', 'false']).optional() })
      .parse(req.query);
    return (await wsd(req.params.id)).call('git.diff', { cwd: q.cwd, path: q.path || undefined, staged: q.staged === '1' || q.staged === 'true' });
  });

  for (const op of ['stage', 'unstage', 'discard'] as const) {
    app.post<P>(`/api/projects/:id/git/${op}`, async (req) => {
      const body = z.object({ cwd, paths }).parse(req.body);
      const r = await (await wsd(req.params.id)).call(`git.${op}`, body);
      changed(req.params.id);
      return r;
    });
  }

  app.post<P>('/api/projects/:id/git/commit', async (req) => {
    const body = z.object({ cwd, message: z.string().trim().min(1).max(20_000), all: z.boolean().optional() }).parse(req.body);
    const r = await (await wsd(req.params.id)).call('git.commit', body);
    changed(req.params.id);
    return r;
  });

  app.post<P>('/api/projects/:id/git/push', async (req) => {
    const body = z
      .object({ cwd, remote: z.string().max(100).optional(), branch: z.string().max(255).optional(), setUpstream: z.boolean().optional(), force: z.boolean().optional() })
      .parse(req.body ?? {});
    const r = await (await wsd(req.params.id)).call('git.push', body);
    changed(req.params.id);
    if (gh.repoOf(req.params.id)) bus.project(req.params.id, { type: 'github.changed', projectId: req.params.id });
    return r;
  });

  app.post<P>('/api/projects/:id/git/pull', async (req) => {
    const body = z.object({ cwd, remote: z.string().max(100).optional(), branch: z.string().max(255).optional() }).parse(req.body ?? {});
    const r = await (await wsd(req.params.id)).call('git.pull', body);
    changed(req.params.id);
    return r;
  });

  app.post<P>('/api/projects/:id/git/fetch', async (req) => {
    const body = z.object({ cwd, remote: z.string().max(100).optional() }).parse(req.body ?? {});
    const r = await (await wsd(req.params.id)).call('git.fetch', body);
    changed(req.params.id);
    return r;
  });

  app.get<P>('/api/projects/:id/git/branches', async (req) => (await wsd(req.params.id)).call('git.branches', z.object({ cwd }).parse(req.query)));

  app.post<P>('/api/projects/:id/git/checkout', async (req) => {
    const body = z
      .object({ cwd, branch: z.string().trim().min(1).max(255), create: z.boolean().optional(), startPoint: z.string().max(255).optional() })
      .parse(req.body);
    const r = await (await wsd(req.params.id)).call('git.checkout', body);
    changed(req.params.id);
    return r;
  });

  app.get<P>('/api/projects/:id/git/log', async (req) => {
    const q = z.object({ cwd, limit: z.coerce.number().int().min(1).max(500).default(30), ref: z.string().max(255).optional() }).parse(req.query);
    return (await wsd(req.params.id)).call('git.log', q);
  });

  app.post<P>('/api/projects/:id/git/init', async (req) => {
    const body = z.object({ cwd, defaultBranch: z.string().trim().max(100).optional() }).parse(req.body ?? {});
    const client = await wsd(req.params.id);
    const r = await client.call('git.init', body);
    // Linked repo → set origin right away.
    const repo = gh.repoOf(req.params.id);
    if (repo && !body.cwd) await client.call('git.remote.set', { name: 'origin', url: `https://github.com/${repo.owner}/${repo.name}.git` });
    changed(req.params.id);
    return r;
  });

  app.get<P>('/api/projects/:id/git/remote', async (req) => {
    const q = z.object({ cwd, name: z.string().max(100).optional() }).parse(req.query);
    return (await wsd(req.params.id)).call('git.remote.get', q);
  });

  app.put<P>('/api/projects/:id/git/remote', async (req) => {
    const body = z.object({ cwd, name: z.string().trim().min(1).max(100).default('origin'), url: z.string().trim().min(1).max(1000) }).parse(req.body);
    const r = await (await wsd(req.params.id)).call('git.remote.set', body);
    changed(req.params.id);
    return r;
  });

  app.get<P>('/api/projects/:id/git/worktrees', async (req) => (await wsd(req.params.id)).call('git.worktree.list', {}));

  app.post<P>('/api/projects/:id/git/worktrees', async (req) => {
    const body = z.object({ path: z.string().trim().min(1).max(500), branch: z.string().trim().min(1).max(255), base: z.string().max(255).optional() }).parse(req.body);
    const r = await (await wsd(req.params.id)).call('git.worktree.add', body);
    changed(req.params.id);
    return r;
  });

  app.delete<P>('/api/projects/:id/git/worktrees', async (req) => {
    const q = z.object({ path: z.string().trim().min(1).max(500), force: z.enum(['1', '0', 'true', 'false']).optional() }).parse(req.query);
    const r = await (await wsd(req.params.id)).call('git.worktree.remove', { path: q.path, force: q.force === '1' || q.force === 'true' });
    changed(req.params.id);
    return r;
  });
}
