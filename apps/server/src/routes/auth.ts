import type { FastifyInstance } from 'fastify';
import { AGENT_MANIFESTS, type MeResponse, type SystemInfo } from '@vibe/shared';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { SESSION_COOKIE } from '../auth.js';
import { HttpError } from '../workspaces/manager.js';

const credentials = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { auth } = ctx;

  const me = (authenticated: boolean): MeResponse => ({
    setupRequired: !auth.hasAdmin(),
    authenticated,
    username: authenticated ? auth.username() : null,
    secretKeyFromEnv: ctx.secrets.keyFromEnv,
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/me', async (req) => me(auth.isAuthenticated(req.cookies[SESSION_COOKIE])));

  app.post('/api/auth/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.extend({ setupToken: z.string().min(1) }).parse(req.body);
    await auth.setup(body.setupToken, body.username, body.password);
    auth.createSession(req, reply);
    return me(true);
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.parse(req.body);
    if (!(await auth.login(body.username, body.password))) {
      throw new HttpError(401, 'invalid_credentials', 'Benutzername oder Passwort falsch');
    }
    auth.createSession(req, reply);
    return me(true);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/system', async (): Promise<SystemInfo> => {
    const docker = await ctx.orch.ping();
    return {
      previewMode: ctx.cfg.previewMode,
      dockerOk: docker.ok,
      dockerError: docker.error,
      workspaceImage: ctx.cfg.workspaceImage,
      workspaceImagePresent: docker.ok ? await ctx.orch.imagePresent(ctx.cfg.workspaceImage) : false,
      version: ctx.cfg.version,
    };
  });

  app.get('/api/agents', async () => AGENT_MANIFESTS);
}
