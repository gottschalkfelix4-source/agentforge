import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { bus } from '../events.js';
import { PreviewService } from '../preview/service.js';
import { HttpError } from '../workspaces/manager.js';

const openSchema = z.object({ port: z.number().int().min(1).max(65535) });

// Phase 4 – live preview proxy. See docs/preview.md.
export async function previewsRoutes(app: FastifyInstance, ctx: AppContext) {
  const service = new PreviewService(
    ctx.cfg,
    (projectId) => ctx.workspaces.tunnelTarget(projectId),
    { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
    (projectId) => bus.project(projectId, { type: 'previews.changed', projectId }),
  );

  if (ctx.cfg.previewMode === 'subdomain') service.attachSubdomain(app.server);
  else await service.startPortListeners();
  app.addHook('onClose', async () => service.close());

  const projectExists = (id: string) => {
    if (!ctx.db.get('SELECT id FROM projects WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Projekt nicht gefunden');
  };
  const ensureAvailable = () => {
    if (!service.available) {
      throw new HttpError(
        503,
        'preview_unavailable',
        ctx.cfg.previewMode === 'subdomain'
          ? 'Vorschau nicht konfiguriert: PREVIEW_DOMAIN fehlt.'
          : 'Keine Vorschau-Ports verfügbar (Port-Bereich belegt?).',
      );
    }
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/previews', async (req) => {
    projectExists(req.params.id);
    return service.list(req.params.id, req.protocol === 'https' ? 'https' : 'http');
  });

  // Idempotent: returns the existing slot for (project, port) with a fresh one-time token.
  app.post<{ Params: { id: string } }>('/api/projects/:id/previews', async (req) => {
    projectExists(req.params.id);
    ensureAvailable();
    const { port } = openSchema.parse(req.body);
    return service.open(req.params.id, port, req.protocol === 'https' ? 'https' : 'http');
  });

  app.delete<{ Params: { slot: string } }>('/api/previews/:slot', async (req) => {
    const slot = Number(req.params.slot);
    if (!Number.isInteger(slot) || !service.release(slot)) throw new HttpError(404, 'not_found', 'Vorschau nicht gefunden');
    return { ok: true };
  });
}
