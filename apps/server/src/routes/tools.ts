import type { FastifyInstance } from 'fastify';
import { getAgentManifest } from '@vibe/shared';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { bus } from '../events.js';
import { combineStatus, installLaunch, isInstallable, LatestVersions } from '../tools/service.js';
import { HttpError } from '../workspaces/manager.js';

const installBody = z.object({
  agentId: z.string().min(1),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

// Phase 6 – agent CLI versions and install/update. Provider tests live in routes/providers.ts.
export async function toolsRoutes(app: FastifyInstance, ctx: AppContext) {
  const latest = new LatestVersions();

  /** Latest published versions only (no workspace needed). */
  app.get('/api/tools/latest', async () => combineStatus(null, latest));

  /** Installed (in this workspace) vs. latest versions of all agent CLIs. */
  app.get<{ Params: { id: string } }>('/api/projects/:id/tools', async (req) => {
    const client = await ctx.workspaces.waitForClient(req.params.id, 5_000);
    const versions = await client.call('tools.versions', {}, { timeoutMs: 20_000 });
    return combineStatus(versions, latest);
  });

  /** Opens a terminal in the workspace that installs/updates the agent into the shared /opt/vibe-tools volume. */
  app.post<{ Params: { id: string } }>('/api/projects/:id/tools/install', async (req) => {
    const { agentId, cols, rows } = installBody.parse(req.body);
    const m = getAgentManifest(agentId);
    if (!m) throw new HttpError(400, 'invalid_agent', `Unbekannter Agent: ${agentId}`);
    if (!isInstallable(m)) throw new HttpError(400, 'not_installable', `${m.label} kann nicht automatisch installiert werden`);
    const client = await ctx.workspaces.waitForClient(req.params.id, 5_000);
    const term = await client.call('term.create', { ...installLaunch(m.id), cols, rows });
    bus.project(req.params.id, { type: 'term.created', projectId: req.params.id, termId: term.id });
    return term;
  });
}
