import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Channel, ClientMessage, ServerMessage } from '@vibe/shared';
import type { WebSocket, RawData } from 'ws';
import type { AppContext } from '../app-context.js';
import { SESSION_COOKIE } from '../auth.js';
import { bus } from '../events.js';

/** WebSocket upgrades must carry a valid session and come from the app's own origin. */
function upgradeAllowed(req: FastifyRequest, ctx: AppContext): boolean {
  if (!ctx.auth.isAuthenticated(req.cookies[SESSION_COOKIE])) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return true;
  } catch {
    return false;
  }
  return ctx.cfg.allowedOrigins.includes(origin);
}

export async function wsRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!upgradeAllowed(req, ctx)) return reply.code(401).send({ error: 'unauthorized', message: 'Nicht angemeldet' });
  };

  app.get('/ws', { websocket: true, preValidation: guard }, (socket: WebSocket) => {
    const subs = new Set<Channel>();
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const unsubscribe = bus.subscribe((ch, e) => {
      if (subs.has(ch)) send({ t: 'ev', ch, e });
    });
    const ping = setInterval(() => send({ t: 'ping' }), 25_000);

    socket.on('message', (raw: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === 'sub') subs.add(msg.ch);
      else if (msg.t === 'unsub') subs.delete(msg.ch);
    });
    socket.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // Bridges a browser terminal socket to the workspace daemon's terminal stream.
  app.get<{ Params: { projectId: string; termId: string } }>(
    '/ws/term/:projectId/:termId',
    { websocket: true, preValidation: guard },
    async (browser: WebSocket, req) => {
      const { projectId, termId } = req.params;
      const pendingInput: { data: RawData; isBinary: boolean }[] = [];
      let upstream: WebSocket | null = null;

      const fail = (message: string) => {
        if (browser.readyState === browser.OPEN) {
          browser.send(JSON.stringify({ type: 'error', message }));
          browser.close(1011, 'upstream');
        }
      };

      browser.on('message', (data: RawData, isBinary: boolean) => {
        if (upstream && upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
        else if (pendingInput.length < 1000) pendingInput.push({ data, isBinary });
      });
      browser.on('close', () => upstream?.close());

      try {
        // Right after a server restart the daemon connection may still be coming up.
        upstream = await (await ctx.workspaces.waitForClient(projectId, 15_000)).openTerminal(termId);
        if (browser.readyState !== browser.OPEN) return upstream.close();
      } catch (err) {
        return fail((err as Error).message);
      }
      upstream.on('open', () => {
        for (const m of pendingInput.splice(0)) upstream!.send(m.data, { binary: m.isBinary });
      });
      upstream.on('message', (data: RawData, isBinary: boolean) => {
        if (browser.readyState === browser.OPEN) browser.send(data, { binary: isBinary });
      });
      upstream.on('error', (err: Error) => fail(err.message));
      upstream.on('close', () => {
        if (browser.readyState === browser.OPEN) browser.close(1000);
      });
    },
  );
}
