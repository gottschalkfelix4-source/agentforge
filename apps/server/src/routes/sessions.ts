import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { SessionService, toSession } from '../sessions/service.js';

// Phase 2 – structured agent sessions (chat). Service + event persistence in ../sessions/.

const imageSchema = z.object({ mime: z.string().regex(/^image\/[a-z0-9.+-]+$/i), data: z.string().min(1) });
const createBody = z.object({
  agentId: z.string().min(1),
  profileId: z.string().nullish(),
  title: z.string().trim().max(200).optional(),
  cwd: z
    .string()
    .trim()
    .max(500)
    .refine((p) => !p.split(/[\\/]/).includes('..'), 'Ungültiger Pfad')
    .optional(),
  initialPrompt: z.string().max(200_000).optional(),
  model: z.string().trim().min(1).max(300).nullish(),
});
const promptBody = z.object({ text: z.string().max(200_000), images: z.array(imageSchema).max(20).optional() });
const approvalBody = z.object({ requestId: z.string().min(1), optionId: z.string().min(1) });
const eventsQuery = z.object({ since: z.coerce.number().int().min(0).default(0) });

export async function sessionsRoutes(app: FastifyInstance, ctx: AppContext) {
  const svc = new SessionService(ctx, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
  svc.attach();
  const { store } = svc;

  type P = { Params: { id: string } };
  type S = { Params: { sid: string } };

  app.get<P>('/api/projects/:id/sessions', async (req) => svc.listSessions(req.params.id));
  app.post<P>('/api/projects/:id/sessions', async (req) => svc.create(req.params.id, createBody.parse(req.body)));

  app.get<S>('/api/sessions/:sid', async (req) => toSession(store.require(req.params.sid)));
  app.patch<S>('/api/sessions/:sid', async (req) =>
    svc.rename(req.params.sid, z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body).title),
  );
  app.delete<S>('/api/sessions/:sid', async (req) => svc.remove(req.params.sid));

  app.get<S>('/api/sessions/:sid/events', async (req) => {
    store.require(req.params.sid);
    return store.events(req.params.sid, eventsQuery.parse(req.query).since);
  });

  app.post<S>('/api/sessions/:sid/prompt', async (req) => {
    const body = promptBody.parse(req.body);
    return svc.prompt(req.params.sid, body.text, body.images);
  });
  app.post<S>('/api/sessions/:sid/cancel', async (req) => svc.cancel(req.params.sid));
  app.post<S>('/api/sessions/:sid/approval', async (req) => {
    const body = approvalBody.parse(req.body);
    return svc.respond(req.params.sid, body.requestId, body.optionId);
  });
  app.post<S>('/api/sessions/:sid/answer', async (req) => {
    const body = z
      .object({
        requestId: z.string().min(1),
        action: z.enum(['accept', 'decline', 'cancel']),
        answers: z.record(z.string(), z.union([z.string().max(20_000), z.array(z.string().max(2_000)).max(100), z.boolean(), z.number()])).optional(),
      })
      .parse(req.body);
    return svc.answer(req.params.sid, body);
  });
  app.post<S>('/api/sessions/:sid/mode', async (req) => svc.setMode(req.params.sid, z.object({ mode: z.string().min(1) }).parse(req.body).mode));
  app.post<S>('/api/sessions/:sid/model', async (req) => svc.setModel(req.params.sid, z.object({ model: z.string().min(1) }).parse(req.body).model));
  app.post<S>('/api/sessions/:sid/stop', async (req) => svc.stop(req.params.sid));
  app.post<S>('/api/sessions/:sid/resume', async (req) => svc.resume(req.params.sid));

  app.get('/api/settings/chat', async () => svc.chatSettings());
  app.put('/api/settings/chat', async (req) =>
    svc.setChatSettings(z.object({ allowClaudeSubscriptionChat: z.boolean() }).parse(req.body)),
  );
}
