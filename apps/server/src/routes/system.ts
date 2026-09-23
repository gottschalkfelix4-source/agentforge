import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { createBackupStream } from '../ops/backup.js';
import { effectiveIdleMinutes, envIdleMinutes, IdleStopper, setStoredIdleMinutes, storedIdleMinutes } from '../ops/idle.js';
import { DiskUsageCache, imageInfo, ImagePuller, outdatedWorkspaces } from '../ops/system-info.js';

// Phase 7 – operations: system info, backup/export, image update, idle auto-stop.
// Response shapes are documented in docs/api.md (section "System / Betrieb").

const settingsBody = z.object({
  /** Minutes without running terminals/agents before a workspace is stopped; 0 = off, null = use env default. */
  workspaceIdleMinutes: z.number().int().min(0).max(7 * 24 * 60).nullable(),
});

export async function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  const log = { info: (m: string) => app.log.info(m), warn: (m: string) => app.log.warn(m) };
  const disk = new DiskUsageCache(ctx.cfg.dataDir);
  const puller = new ImagePuller(ctx.orch.docker, ctx.cfg.workspaceImage);
  const idle = new IdleStopper({ db: ctx.db, workspaces: ctx.workspaces, log });
  idle.start();
  app.addHook('onClose', async () => idle.stopTimer());

  const settings = () => ({
    workspaceIdleMinutes: effectiveIdleMinutes(ctx.db),
    workspaceIdleMinutesStored: storedIdleMinutes(ctx.db),
    workspaceIdleMinutesEnv: envIdleMinutes(),
  });

  app.get<{ Querystring: { refresh?: string } }>('/api/system/info', async (req) => {
    const docker = await ctx.orch.ping();
    const image = docker.ok ? await imageInfo(ctx.orch.docker, ctx.cfg.workspaceImage) : null;
    const counts = ctx.db.get<{ total: number; running: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running FROM workspaces",
    )!;
    return {
      version: ctx.cfg.version,
      nodeVersion: process.version,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptimeSec: Math.round(process.uptime()),
      dataDir: ctx.cfg.dataDir,
      hostDataPath: ctx.cfg.hostDataPath,
      inContainer: ctx.cfg.inContainer,
      previewMode: ctx.cfg.previewMode,
      previewDomain: ctx.cfg.previewDomain,
      secretKeyFromEnv: ctx.secrets.keyFromEnv,
      docker: docker,
      workspaceImage: image ?? { name: ctx.cfg.workspaceImage, present: false, id: null, digest: null, created: null, sizeBytes: null, version: null },
      outdatedWorkspaces:
        docker.ok && image?.id
          ? await outdatedWorkspaces(
              ctx.orch.docker,
              image.id,
              ctx.db.all<{ container_id: string }>('SELECT container_id FROM workspaces WHERE container_id IS NOT NULL').map((r) => r.container_id),
            ).catch(() => 0)
          : 0,
      workspaces: { total: counts.total, running: counts.running, connected: ctx.workspaces.connectedProjects().length },
      disk: await disk.get(req.query.refresh === '1'),
      idle: { ...settings(), idleSince: idle.snapshot() },
      pull: puller.state(),
    };
  });

  app.get('/api/system/settings', async () => settings());

  app.put('/api/system/settings', async (req) => {
    const body = settingsBody.parse(req.body);
    setStoredIdleMinutes(ctx.db, body.workspaceIdleMinutes);
    void idle.tick();
    return settings();
  });

  // Streams a .tar.gz: consistent SQLite snapshot (+ secret.key if file based, + projects/ with ?projects=1).
  app.get<{ Querystring: { projects?: string } }>(
    '/api/system/backup',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const includeProjects = req.query.projects === '1' || req.query.projects === 'true';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
      const stream = createBackupStream({
        db: ctx.db.raw,
        dataDir: ctx.cfg.dataDir,
        version: ctx.cfg.version,
        includeProjects,
        keyFromEnv: ctx.secrets.keyFromEnv,
        log,
      });
      log.info(`Backup gestartet (Projektdateien: ${includeProjects ? 'ja' : 'nein'})`);
      return reply
        .header('Content-Type', 'application/gzip')
        .header('Content-Disposition', `attachment; filename="agentforge-backup-${stamp}${includeProjects ? '-full' : ''}.tar.gz"`)
        .header('Cache-Control', 'no-store')
        .header('X-Vibe-Backup-Secret-Key', ctx.secrets.keyFromEnv ? 'env' : 'included')
        .send(stream);
    },
  );

  // Background pull of the workspace image; poll with GET.
  app.post('/api/system/pull-image', async () => {
    const docker = await ctx.orch.ping();
    if (!docker.ok) return { ...puller.state(), state: 'error' as const, error: `Docker nicht erreichbar: ${docker.error}` };
    return puller.start(log);
  });
  app.get('/api/system/pull-image', async () => puller.state());
}
