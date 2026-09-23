import { mkdirSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Project, ProjectWithWorkspace, WorkspaceAction } from '@vibe/shared';
import { ulid } from 'ulid';
import { z } from 'zod';
import { buildAgentLaunch } from '../agents/launch.js';
import type { AppContext } from '../app-context.js';
import { nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { githubService } from '../github/service.js';
import { HttpError } from '../workspaces/manager.js';
import { providerRepo } from './providers.js';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  git_url: string | null;
  default_branch: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  created_at: string;
  archived: number;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  gitUrl: r.git_url,
  defaultBranch: r.default_branch,
  repoOwner: r.repo_owner,
  repoName: r.repo_name,
  createdAt: r.created_at,
  archived: !!r.archived,
});

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'projekt';
}

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  gitUrl: z
    .string()
    .trim()
    .regex(/^(https?:\/\/|git@|ssh:\/\/)\S+$/, 'Ungültige Git-URL')
    .nullish()
    .or(z.literal('').transform(() => null)),
  // Phase 3: link a GitHub repo (cloned via wsd RPC with the stored token, see github/service.ts).
  repo: z
    .object({
      owner: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
      name: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
    })
    .nullish(),
});
const updateBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  archived: z.boolean().optional(),
  repoOwner: z.string().trim().min(1).nullish(),
  repoName: z.string().trim().min(1).nullish(),
});
const terminalBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shell'), cols: z.number().int().positive().optional(), rows: z.number().int().positive().optional() }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string(),
    mode: z.enum(['run', 'login']),
    profileId: z.string().nullish(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  }),
]);
const pathQuery = z.object({ path: z.string().default('.') });

export async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, workspaces } = ctx;
  const repo = providerRepo(ctx);

  const load = (id: string): ProjectWithWorkspace => {
    const r = db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'not_found', 'Projekt nicht gefunden');
    return { ...toProject(r), workspace: workspaces.get(id) };
  };

  /** Starts the workspace in the background; failures surface as workspace status. */
  const bootInBackground = (projectId: string) => {
    workspaces.ensureRunning(projectId).catch((err: Error) => app.log.warn(`workspace ${projectId}: ${err.message}`));
  };

  app.get('/api/projects', async () =>
    db
      .all<ProjectRow>('SELECT * FROM projects ORDER BY archived, created_at DESC')
      .map((r) => ({ ...toProject(r), workspace: workspaces.get(r.id) })),
  );

  app.post('/api/projects', async (req) => {
    const body = createBody.parse(req.body);
    const ghRepo = body.repo ? await githubService(ctx).getRepo(body.repo.owner, body.repo.name) : null;
    const id = ulid();
    let slug = slugify(body.name);
    if (db.get('SELECT id FROM projects WHERE slug = ?', slug)) slug = `${slug}-${id.slice(-6).toLowerCase()}`;
    mkdirSync(ctx.orch.localPath('projects', id), { recursive: true });
    db.tx(() => {
      db.insert('projects', {
        id,
        name: body.name,
        slug,
        git_url: ghRepo ? ghRepo.cloneUrl : (body.gitUrl ?? null),
        default_branch: ghRepo?.defaultBranch ?? null,
        repo_owner: ghRepo?.owner ?? null,
        repo_name: ghRepo?.name ?? null,
        created_at: nowIso(),
        archived: 0,
      });
      workspaces.createRecord(id);
    });
    bus.publish('projects', { type: 'projects.changed' });
    bootInBackground(id);
    return load(id);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req) => load(req.params.id));

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req) => {
    load(req.params.id);
    const body = updateBody.parse(req.body);
    db.update('projects', req.params.id, {
      name: body.name,
      archived: body.archived === undefined ? undefined : Number(body.archived),
      repo_owner: body.repoOwner === undefined ? undefined : body.repoOwner,
      repo_name: body.repoName === undefined ? undefined : body.repoName,
    });
    bus.publish('projects', { type: 'projects.changed' });
    return load(req.params.id);
  });

  app.delete<{ Params: { id: string }; Querystring: { deleteFiles?: string } }>('/api/projects/:id', async (req) => {
    load(req.params.id);
    await workspaces.destroy(req.params.id, req.query.deleteFiles === '1' || req.query.deleteFiles === 'true');
    db.run('DELETE FROM projects WHERE id = ?', req.params.id);
    bus.publish('projects', { type: 'projects.changed' });
    return { ok: true };
  });

  app.post<{ Params: { id: string; action: WorkspaceAction } }>('/api/projects/:id/workspace/:action', async (req) => {
    const { id, action } = req.params;
    load(id);
    switch (action) {
      case 'start':
        bootInBackground(id);
        break;
      case 'stop':
        await workspaces.stop(id);
        break;
      case 'restart':
        workspaces.restart(id).catch((err: Error) => app.log.warn(err.message));
        break;
      case 'recreate':
        workspaces.recreate(id).catch((err: Error) => app.log.warn(err.message));
        break;
      default:
        throw new HttpError(400, 'invalid_action', 'Unbekannte Aktion');
    }
    return workspaces.get(id);
  });

  // ---- terminals ----------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/projects/:id/terminals', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('term.list', {}),
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/terminals', async (req) => {
    const body = terminalBody.parse(req.body);
    const client = await workspaces.waitForClient(req.params.id, 5_000);
    let params;
    if (body.kind === 'shell') {
      params = { title: 'Terminal' };
    } else {
      const profile = body.profileId ? repo.profile(body.profileId) : null;
      if (body.profileId && !profile) throw new HttpError(400, 'invalid_profile', 'Profil nicht gefunden');
      const provider = profile?.providerId ? repo.get(profile.providerId) : null;
      const apiKey = provider?.secretId ? ctx.secrets.get(provider.secretId) : null;
      params = buildAgentLaunch(body.agentId, body.mode, { profile, provider, apiKey });
    }
    // GitHub token for the `gh` CLI (process env only, never container env).
    // Not for Copilot: it prefers GH_TOKEN over its own login, and our token usually lacks Copilot access.
    const ghToken = body.kind === 'agent' && body.agentId === 'copilot' ? null : githubService(ctx).getToken();
    if (ghToken) params = { ...params, env: { ...('env' in params ? params.env : {}), GH_TOKEN: ghToken } };
    const term = await client.call('term.create', { ...params, cols: body.cols, rows: body.rows });
    bus.project(req.params.id, { type: 'term.created', projectId: req.params.id, termId: term.id });
    return term;
  });

  app.delete<{ Params: { id: string; termId: string } }>('/api/projects/:id/terminals/:termId', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('term.kill', { id: req.params.termId }),
  );

  // ---- files --------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/projects/:id/fs', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('fs.list', pathQuery.parse(req.query)),
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/fs/file', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('fs.read', { path: z.object({ path: z.string().min(1) }).parse(req.query).path }),
  );

  app.put<{ Params: { id: string } }>('/api/projects/:id/fs/file', async (req) => {
    const body = z
      .object({ path: z.string().min(1), content: z.string(), encoding: z.enum(['utf8', 'base64']).optional() })
      .parse(req.body);
    return (await workspaces.waitForClient(req.params.id, 5_000)).call('fs.write', body);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/fs/mkdir', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('fs.mkdir', z.object({ path: z.string().min(1) }).parse(req.body)),
  );

  app.post<{ Params: { id: string } }>('/api/projects/:id/fs/rename', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('fs.rename', z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(req.body)),
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id/fs', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('fs.delete', { path: z.object({ path: z.string().min(1) }).parse(req.query).path }),
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/ports', async (req) =>
    (await workspaces.waitForClient(req.params.id, 5_000)).call('ports.list', {}),
  );
}
