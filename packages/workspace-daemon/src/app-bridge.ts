import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { ModuleHandlers, WsdContext } from './module.js';

// Lets processes inside the workspace (the `agentforge-mcp` server started by agents) call the app:
// POST /app-call {method, params, sessionId} → `app.request` notification → app answers via `app.respond`.
// Auth: the same bearer token as the RPC channel (readable by the workspace user).

const CALL_TIMEOUT_MS = 30_000;
const MAX_BODY = 1024 * 1024;

interface Pending {
  resolve: (r: { result?: unknown; error?: string }) => void;
  timer: NodeJS.Timeout;
}

export function createAppBridge(ctx: WsdContext & { connectedApps: () => number }) {
  const pending = new Map<string, Pending>();

  const handlers: ModuleHandlers<'app.respond'> = {
    'app.respond': (p) => {
      const entry = pending.get(String(p.id));
      if (entry) {
        pending.delete(String(p.id));
        clearTimeout(entry.timer);
        entry.resolve(p.error !== undefined ? { error: String(p.error) } : { result: p.result });
      }
      return { ok: true };
    },
  };

  function reply(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** Handles an authenticated POST /app-call. */
  function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let body: { method?: unknown; params?: unknown; sessionId?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(res, 400, { error: 'invalid JSON' });
      }
      if (typeof body.method !== 'string') return reply(res, 400, { error: 'method missing' });
      if (ctx.connectedApps() === 0) return reply(res, 503, { error: 'Agentforge ist gerade nicht mit diesem Workspace verbunden' });
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reply(res, 504, { error: 'Agentforge hat nicht rechtzeitig geantwortet' });
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve: (r) => reply(res, 200, r), timer });
      ctx.notify('app.request', {
        id,
        method: body.method,
        params: body.params ?? {},
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      });
    });
  }

  return { handlers, handle };
}
