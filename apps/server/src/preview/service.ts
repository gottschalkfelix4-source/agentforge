import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { PREVIEW_INJECT_PATH, PREVIEW_QUERY_TOKEN, type PreviewSlot } from '@vibe/shared';
import type { Config } from '../config.js';
import { PV_ACTIVE_COOKIE, PV_COOKIE_MAX_AGE_MS, getCookie, previewCookieName, signPreviewCookie, verifyPreviewCookie } from './cookies.js';
import { forwardRequestHeaders, transformResponseHeaders } from './headers.js';
import { HtmlInjector, INJECT_SCRIPT, INJECT_TAG, shouldInject } from './inject.js';
import { SlotTable, type SlotEntry } from './slots.js';

export interface TunnelTarget {
  host: string;
  port: number;
  token: string;
}

export type TargetResolver = (projectId: string) => Promise<TunnelTarget>;

interface Logger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

type Proto = 'http' | 'https';

const TARGET_TTL_MS = 15_000;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Small German status page shown inside the preview frame. */
export function statusPage(title: string, text: string, opts: { authRequired?: boolean; refreshSeconds?: number } = {}): string {
  const auth = opts.authRequired
    ? `<script>try{window.parent!==window&&window.parent.postMessage({source:'vibe-preview',type:'auth-required',ts:Date.now()},'*')}catch(e){}</script>`
    : '';
  const refresh = opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : '';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">${refresh}<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${opts.authRequired ? '' : INJECT_TAG}
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#09090b;color:#a1a1aa;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:420px;padding:24px;text-align:center}h1{color:#fafafa;font-size:16px;font-weight:600;margin:0 0 8px}p{margin:0}</style>${auth}</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
}

function sendPage(res: http.ServerResponse, status: number, html: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

function rejectSocket(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Removes `__vibe_pv=…` from a raw request target, keeping every other parameter byte-for-byte. */
export function stripTokenParam(rawUrl: string): { path: string; token: string | null } {
  const q = rawUrl.indexOf('?');
  if (q < 0) return { path: rawUrl, token: null };
  let token: string | null = null;
  const kept = rawUrl
    .slice(q + 1)
    .split('&')
    .filter((p) => {
      if (p === PREVIEW_QUERY_TOKEN || p.startsWith(`${PREVIEW_QUERY_TOKEN}=`)) {
        token = decodeURIComponent(p.slice(PREVIEW_QUERY_TOKEN.length + 1));
        return false;
      }
      return true;
    });
  const base = rawUrl.slice(0, q);
  return { path: kept.length ? `${base}?${kept.join('&')}` : base, token };
}

function requestProto(req: http.IncomingMessage): Proto {
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase();
  if (fwd === 'https' || fwd === 'http') return fwd;
  return (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
}

/**
 * Live preview proxy. Slots map (project, container port) to a host port (port mode) or a subdomain
 * (`p<slot>.<PREVIEW_DOMAIN>`) or a shared hostname (host mode, PREVIEW_HOST). Traffic: browser → here → wsd `/proxy/<port>/…` → 127.0.0.1:<port>.
 */
export class PreviewService {
  readonly slots: SlotTable;
  private readonly secret = randomBytes(32);
  private readonly servers: http.Server[] = [];
  private readonly targets = new Map<string, { target: TunnelTarget; at: number }>();
  private readonly agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10_000 });

  constructor(
    private readonly cfg: Pick<Config, 'previewMode' | 'previewDomain' | 'previewHost' | 'previewPortStart' | 'previewPortCount' | 'host'>,
    private readonly resolveTarget: TargetResolver,
    private readonly log: Logger,
    private readonly onChange: (projectId: string) => void,
  ) {
    this.slots = new SlotTable(Math.max(1, cfg.previewPortCount));
  }

  // ---- slots API ------------------------------------------------------------

  private dto(entry: SlotEntry, proto: Proto): PreviewSlot {
    const mode = this.cfg.previewMode;
    return {
      slot: entry.slot,
      projectId: entry.projectId,
      port: entry.port,
      hostPort: mode === 'port' ? this.cfg.previewPortStart + entry.slot : null,
      origin:
        mode === 'subdomain'
          ? `${proto}://p${entry.slot}.${this.cfg.previewDomain}`
          : mode === 'host'
            ? `${proto}://${this.cfg.previewHost}`
            : null,
      exclusive: mode === 'host',
      token: this.slots.issueToken(entry.slot),
      createdAt: entry.createdAt,
    };
  }

  get available(): boolean {
    if (this.cfg.previewMode === 'subdomain') return !!this.cfg.previewDomain;
    if (this.cfg.previewMode === 'host') return !!this.cfg.previewHost;
    return this.slots.usable > 0;
  }

  open(projectId: string, port: number, proto: Proto): PreviewSlot {
    const { entry, created, evicted } = this.slots.acquire(projectId, port);
    if (evicted) this.onChange(evicted.projectId);
    if (created) this.onChange(projectId);
    return this.dto(entry, proto);
  }

  list(projectId: string, proto: Proto): PreviewSlot[] {
    return this.slots.list(projectId).map((e) => this.dto(e, proto));
  }

  release(slot: number): SlotEntry | undefined {
    const e = this.slots.release(slot);
    if (e) this.onChange(e.projectId);
    return e;
  }

  // ---- listeners --------------------------------------------------------------

  /** Port mode: one HTTP server per slot on previewPortStart+slot. */
  async startPortListeners(): Promise<void> {
    const { previewPortStart: start, host } = this.cfg;
    await Promise.all(
      Array.from({ length: this.slots.count }, (_, slot) => {
        const server = http.createServer((req, res) => void this.handleRequest(req, res, slot, requestProto(req)));
        server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head, slot, requestProto(req)));
        server.on('clientError', (_err, socket) => socket.destroy());
        return new Promise<void>((resolve) => {
          server.once('error', (err: NodeJS.ErrnoException) => {
            this.log.warn(`Vorschau-Port ${start + slot} konnte nicht geöffnet werden: ${err.code ?? err.message}`);
            this.slots.disable(slot);
            resolve();
          });
          server.listen(start + slot, host, () => {
            this.servers.push(server);
            resolve();
          });
        });
      }),
    );
    this.log.info(`Vorschau-Ports ${start}–${start + this.slots.count - 1}: ${this.slots.usable} aktiv`);
  }

  /**
   * Subdomain mode: requests on the main server whose Host is `p<slot>.<domain>` are handled here, before
   * Fastify (so neither the API auth hook nor the SPA fallback sees them). Same for WebSocket upgrades.
   */
  attachSubdomain(server: http.Server) {
    const domain = (this.cfg.previewDomain ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!domain) {
      this.log.warn('PREVIEW_MODE=subdomain, aber PREVIEW_DOMAIN ist nicht gesetzt – Vorschau deaktiviert.');
      return;
    }
    const re = new RegExp(`^p(\\d{1,4})\\.${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::\\d+)?$`);
    const match = (req: http.IncomingMessage): number | null => {
      const m = re.exec(String(req.headers.host ?? '').toLowerCase());
      if (!m) return null;
      const slot = Number(m[1]);
      return slot < this.slots.count ? slot : null;
    };
    this.intercept(server, match);
    this.log.info(`Vorschau über Subdomains p<slot>.${this.cfg.previewDomain}`);
  }

  /**
   * Host mode: every request on PREVIEW_HOST is a preview request. All slots share that origin; the first
   * request carries a token naming its slot, later ones follow the `vibe_pv_active` cookie it set.
   */
  attachHost(server: http.Server) {
    const host = (this.cfg.previewHost ?? '').replace(/:\d+$/, '');
    if (!host) {
      this.log.warn('PREVIEW_MODE=host, aber PREVIEW_HOST ist nicht gesetzt – Vorschau deaktiviert.');
      return;
    }
    this.intercept(server, (req) => {
      if (String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '') !== host) return null;
      const token = stripTokenParam(req.url ?? '/').token;
      const fromToken = token === null ? null : this.slots.tokenSlot(token);
      if (fromToken !== null) return fromToken;
      const active = Number(getCookie(req.headers.cookie, PV_ACTIVE_COOKIE) ?? NaN);
      // -1: ours, but no slot yet → "not signed in" page, the panel then retries with a fresh token.
      return Number.isInteger(active) && active >= 0 && active < this.slots.count ? active : -1;
    });
    this.log.info(`Vorschau über ${this.cfg.previewHost}`);
  }

  /** Hands requests/upgrades `match` claims (returns a slot) to the preview proxy before Fastify sees them. */
  private intercept(server: http.Server, match: (req: http.IncomingMessage) => number | null) {
    const requestListeners = server.listeners('request') as ((req: http.IncomingMessage, res: http.ServerResponse) => void)[];
    server.removeAllListeners('request');
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      const slot = match(req);
      if (slot !== null) return void this.handleRequest(req, res, slot, requestProto(req));
      for (const l of requestListeners) l.call(server, req, res);
    });
    const upgradeListeners = server.listeners('upgrade') as ((req: http.IncomingMessage, s: Duplex, h: Buffer) => void)[];
    server.removeAllListeners('upgrade');
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const slot = match(req);
      if (slot !== null) return void this.handleUpgrade(req, socket, head, slot, requestProto(req));
      for (const l of upgradeListeners) l.call(server, req, socket, head);
    });
  }

  async close() {
    this.agent.destroy();
    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.close(() => r());
            s.closeAllConnections();
          }),
      ),
    );
  }

  // ---- proxy ------------------------------------------------------------------

  private async target(projectId: string): Promise<TunnelTarget> {
    const hit = this.targets.get(projectId);
    if (hit && Date.now() - hit.at < TARGET_TTL_MS) return hit.target;
    const target = await this.resolveTarget(projectId);
    this.targets.set(projectId, { target, at: Date.now() });
    return target;
  }

  private cookieValid(req: http.IncomingMessage, entry: SlotEntry): boolean {
    const value = getCookie(req.headers.cookie, previewCookieName(entry.slot));
    return verifyPreviewCookie(this.secret, value, { slot: entry.slot, projectId: entry.projectId, port: entry.port });
  }

  private cookie(name: string, value: string, proto: Proto): string {
    const secure = proto === 'https';
    // Subdomain/host mode: the preview may be another site than the app → the iframe only sends None cookies.
    const sameSite = this.cfg.previewMode !== 'port' && secure ? 'None' : 'Lax';
    return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(PV_COOKIE_MAX_AGE_MS / 1000)}${secure ? '; Secure' : ''}`;
  }

  private activeCookie(slot: number, proto: Proto): string[] {
    return this.cfg.previewMode === 'host' ? [this.cookie(PV_ACTIVE_COOKIE, String(slot), proto)] : [];
  }

  private publicOrigin(req: http.IncomingMessage, proto: Proto): string {
    return `${proto}://${req.headers.host ?? 'localhost'}`;
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, slot: number, proto: Proto): Promise<void> {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0]!;
    if (pathname === PREVIEW_INJECT_PATH) {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(INJECT_SCRIPT),
      });
      res.end(req.method === 'HEAD' ? undefined : INJECT_SCRIPT);
      return;
    }

    if (slot < 0) {
      return sendPage(res, 401, statusPage('Nicht angemeldet', 'Diese Vorschau ist nur über Agentforge erreichbar. Öffne sie dort erneut.', { authRequired: true }));
    }
    const entry = this.slots.get(slot);
    if (!entry) {
      return sendPage(res, 404, statusPage('Vorschau nicht aktiv', 'Diese Vorschau ist nicht (mehr) aktiv. Öffne sie erneut in Agentforge.', { authRequired: true }));
    }

    const { path, token } = stripTokenParam(rawUrl);
    if (token !== null) {
      if (this.slots.consumeToken(token, slot)) {
        const value = signPreviewCookie(this.secret, { slot, projectId: entry.projectId, port: entry.port });
        res.writeHead(302, {
          location: path || '/',
          'cache-control': 'no-store',
          'set-cookie': [this.cookie(previewCookieName(slot), value, proto), ...this.activeCookie(slot, proto)],
          'content-length': 0,
        });
        res.end();
        return;
      }
      if (this.cookieValid(req, entry)) {
        const active = this.activeCookie(slot, proto);
        res.writeHead(302, {
          location: path || '/',
          'cache-control': 'no-store',
          ...(active.length ? { 'set-cookie': active } : {}),
          'content-length': 0,
        });
        res.end();
        return;
      }
      return sendPage(res, 401, statusPage('Vorschau-Link abgelaufen', 'Der Zugangslink ist ungültig oder abgelaufen. Öffne die Vorschau erneut in Agentforge.', { authRequired: true }));
    }
    if (!this.cookieValid(req, entry)) {
      return sendPage(res, 401, statusPage('Nicht angemeldet', 'Diese Vorschau ist nur über Agentforge erreichbar. Öffne sie dort erneut.', { authRequired: true }));
    }
    this.slots.touch(slot);

    let target: TunnelTarget;
    try {
      target = await this.target(entry.projectId);
    } catch (err) {
      return sendPage(res, 502, statusPage('Workspace nicht erreichbar', (err as Error).message || 'Der Workspace läuft nicht.', { refreshSeconds: 5 }));
    }

    const accept = String(req.headers.accept ?? '');
    const isNavigation = (req.method === 'GET' || req.method === 'HEAD') && accept.includes('text/html');
    const headers = forwardRequestHeaders(req.headers, {
      port: entry.port,
      publicOrigin: this.publicOrigin(req, proto),
      proto,
      remoteAddress: req.socket.remoteAddress,
      wantIdentity: isNavigation,
    });
    headers.authorization = `Bearer ${target.token}`;

    const up = http.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: `/proxy/${entry.port}${path.startsWith('/') ? path : `/${path}`}`,
      headers,
      agent: this.agent,
    });
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    up.on('response', (upRes) => {
      const status = upRes.statusCode ?? 502;
      if (upRes.headers['x-vibe-tunnel-error'] && isNavigation) {
        upRes.resume();
        return sendPage(
          res,
          status,
          statusPage(`Port ${entry.port} antwortet nicht`, `Auf Port ${entry.port} lauscht (noch) kein Server. Die Seite lädt automatisch neu.`, { refreshSeconds: 3 }),
        );
      }
      const inject = shouldInject(req.method, status, upRes.headers);
      res.writeHead(status, upRes.statusMessage, transformResponseHeaders(upRes.headers, entry.port, inject));
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      if (inject) upRes.pipe(new HtmlInjector()).pipe(res);
      else upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    up.on('error', (err) => {
      this.targets.delete(entry.projectId);
      if (res.headersSent) return void res.destroy();
      sendPage(res, 502, statusPage('Workspace nicht erreichbar', `Verbindung zum Workspace fehlgeschlagen (${err.message}).`, { refreshSeconds: 5 }));
    });
    req.pipe(up);
  }

  async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, slot: number, proto: Proto): Promise<void> {
    socket.on('error', () => socket.destroy());
    const entry = this.slots.get(slot);
    if (!entry) return rejectSocket(socket, 404, 'Not Found');
    if (!this.cookieValid(req, entry)) return rejectSocket(socket, 401, 'Unauthorized');
    this.slots.touch(slot);
    let target: TunnelTarget;
    try {
      target = await this.target(entry.projectId);
    } catch {
      return rejectSocket(socket, 502, 'Bad Gateway');
    }
    const headers = forwardRequestHeaders(req.headers, {
      port: entry.port,
      publicOrigin: this.publicOrigin(req, proto),
      proto,
      remoteAddress: req.socket.remoteAddress,
      wantIdentity: false,
      upgrade: true,
    });
    headers.authorization = `Bearer ${target.token}`;
    const path = stripTokenParam(req.url ?? '/').path;
    const lines = [`${req.method ?? 'GET'} /proxy/${entry.port}${path.startsWith('/') ? path : `/${path}`} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);

    const up = net.connect({ host: target.host, port: target.port });
    up.setNoDelay(true);
    let connected = false;
    up.once('connect', () => {
      connected = true;
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => {
      this.targets.delete(entry.projectId);
      if (connected) socket.destroy();
      else if (!socket.destroyed) rejectSocket(socket, 502, 'Bad Gateway');
    });
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  }
}
