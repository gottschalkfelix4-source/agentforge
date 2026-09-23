import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import type { AppContext } from './app-context.js';
import { Auth, AuthError, SESSION_COOKIE } from './auth.js';
import { config } from './config.js';
import { Db } from './db/index.js';
import { Orchestrator } from './docker/orchestrator.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { providerRoutes } from './routes/providers.js';
import { wsRoutes } from './routes/ws.js';
import { sessionsRoutes } from './routes/sessions.js';
import { githubRoutes } from './routes/github.js';
import { previewsRoutes } from './routes/previews.js';
import { pmRoutes } from './routes/pm.js';
import { toolsRoutes } from './routes/tools.js';
import { systemRoutes } from './routes/system.js';
import { SecretStore } from './secrets.js';
import { HttpError, WorkspaceManager } from './workspaces/manager.js';
import { WsdError } from './workspaces/wsd-client.js';

/** Routes reachable without a session. */
const PUBLIC_ROUTES = new Set(['/api/health', '/api/me', '/api/auth/setup', '/api/auth/login']);

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024,
  });

  const db = new Db(path.join(config.dataDir, 'db', 'vibe.sqlite'));
  const secrets = new SecretStore(db, config.dataDir, config.secretKey);
  const auth = new Auth(db, config.dataDir, (m) => app.log.info(m));
  const orch = new Orchestrator(config);
  const workspaces = new WorkspaceManager(db, orch, config, {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });
  const ctx: AppContext = { cfg: config, db, auth, secrets, orch, workspaces };

  if (!secrets.keyFromEnv) {
    app.log.warn('VIBE_SECRET_KEY ist nicht gesetzt – Secrets werden mit einem Schlüssel neben der Datenbank verschlüsselt.');
  }

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  // Auth + CSRF guard for the JSON API. WebSocket routes check auth themselves on upgrade.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-vibe'] !== '1') {
      return reply.code(403).send({ error: 'csrf', message: 'Fehlender X-Vibe-Header' });
    }
    if (PUBLIC_ROUTES.has(url)) return;
    if (!auth.isAuthenticated(req.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Nicht angemeldet' });
    }
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_input', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof AuthError) return reply.code(400).send({ error: err.code, message: err.message });
    if (err instanceof WsdError) return reply.code(502).send({ error: 'workspace', message: err.message });
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: (err as FastifyError).code ?? 'internal', message: err.message });
  });

  await app.register(async (scope) => {
    await authRoutes(scope, ctx);
    await providerRoutes(scope, ctx);
    await projectRoutes(scope, ctx);
    await wsRoutes(scope, ctx);
    // Feature modules (one file each to keep parallel work conflict-free).
    await sessionsRoutes(scope, ctx);
    await githubRoutes(scope, ctx);
    await previewsRoutes(scope, ctx);
    await pmRoutes(scope, ctx);
    await toolsRoutes(scope, ctx);
    await systemRoutes(scope, ctx);
  });

  // Serve the built SPA in production.
  const webDist = config.webDist ?? path.resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found', message: 'Nicht gefunden' });
    });
  } else {
    app.log.info(`Kein Web-Build unter ${webDist} – im Dev-Modus läuft die UI über Vite (:5173).`);
  }

  try {
    orch.ensureAgentDefaults();
  } catch (err) {
    app.log.warn(`Agent-Standardeinstellungen: ${(err as Error).message}`);
  }

  const docker = await orch.ping();
  if (docker.ok) workspaces.startReconciler();
  else app.log.error(`Docker nicht erreichbar: ${docker.error}`);

  setInterval(() => auth.pruneSessions(), 60 * 60 * 1000).unref();

  const shutdown = async () => {
    workspaces.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
}

// Long-lived sockets must not take the whole server down on a single bad connection.
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
