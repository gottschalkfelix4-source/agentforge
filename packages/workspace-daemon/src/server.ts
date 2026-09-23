import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  FsRenameParams,
  FsWriteParams,
  RpcNotification,
  RpcResponse,
  TermCreateParams,
  WsdMethod,
  WsdNotifications,
} from '@vibe/shared';
import { VERSION, type WsdConfig } from './config.js';
import { RpcErrorCode, WsdError, invalidParams, toRpcError } from './errors.js';
import { FsOps } from './fsops.js';
import { PortWatcher } from './ports.js';
import { TerminalManager } from './terminals.js';
import { WorkspaceWatcher } from './watcher.js';
import { createAgentModule } from './agents/index.js';
import { createGitModule } from './git.js';
import type { WsdContext } from './module.js';
import { createToolsModule } from './tools.js';
import { handleProxyRequest, handleProxyUpgrade } from './tunnel.js';

const PROXY_RE = /^\/proxy\/(\d{1,5})(\/.*)?$/;

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

function readToken(cfg: WsdConfig): string | undefined {
  try {
    const t = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    if (t) return t;
  } catch {
    /* fall through to env */
  }
  return cfg.tokenEnv;
}

export function checkBearer(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do a constant-time compare to avoid leaking length via timing shortcuts.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class WsdServer {
  readonly http: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private readonly rpcClients = new Set<WebSocket>();
  readonly terminals: TerminalManager;
  readonly fsops: FsOps;
  private readonly ports: PortWatcher;
  private readonly watcher: WorkspaceWatcher;
  private readonly startedAt = Date.now();
  private readonly handlers: Record<WsdMethod, Handler>;
  private tokenWarned = false;
  private readonly agents: ReturnType<typeof createAgentModule>;

  constructor(private readonly cfg: WsdConfig) {
    this.fsops = new FsOps(cfg.root);
    this.terminals = new TerminalManager(cfg.root, {
      onExit: (id, exitCode) => this.notify('term.exit', { id, exitCode }),
      onTitle: (id, title) => this.notify('term.title', { id, title }),
    });
    this.ports = new PortWatcher([cfg.port], (ports) => this.notify('ports.changed', { ports }));
    this.watcher = new WorkspaceWatcher(cfg.root, (paths) => this.notify('fs.changed', { paths }));

    const moduleCtx: WsdContext = { root: cfg.root, notify: (m, p) => this.notify(m, p) };
    this.agents = createAgentModule(moduleCtx);
    const git = createGitModule(moduleCtx);
    const tools = createToolsModule(moduleCtx);

    const str = (v: unknown, name: string): string => {
      if (typeof v !== 'string') throw invalidParams(`${name} must be a string`);
      return v;
    };
    const core: Record<string, Handler> = {
      ping: () => ({ version: VERSION, uptime: Math.round((Date.now() - this.startedAt) / 1000) }),
      'term.create': (p) => this.terminals.create(p as TermCreateParams),
      'term.list': () => this.terminals.list(),
      'term.kill': (p) => {
        this.terminals.kill(str(p.id, 'id'));
        return { ok: true };
      },
      'term.resize': (p) => {
        this.terminals.resize(str(p.id, 'id'), p.cols, p.rows);
        return { ok: true };
      },
      'fs.list': (p) => this.fsops.list(p.path ?? '.'),
      'fs.read': (p) => this.fsops.read(str(p.path, 'path')),
      'fs.write': async (p) => {
        await this.fsops.write(p as unknown as FsWriteParams);
        return { ok: true };
      },
      'fs.mkdir': async (p) => {
        await this.fsops.mkdir(str(p.path, 'path'));
        return { ok: true };
      },
      'fs.delete': async (p) => {
        await this.fsops.delete(str(p.path, 'path'));
        return { ok: true };
      },
      'fs.rename': async (p) => {
        const { from, to } = p as unknown as FsRenameParams;
        await this.fsops.rename(str(from, 'from'), str(to, 'to'));
        return { ok: true };
      },
      'ports.list': () => this.ports.refresh(),
    };
    this.handlers = {
      ...core,
      // Feature modules (agents, git, tools) live in their own files.
      ...(this.agents.handlers as unknown as Record<string, Handler>),
      ...(git.handlers as unknown as Record<string, Handler>),
      ...(tools.handlers as unknown as Record<string, Handler>),
    } as unknown as Record<WsdMethod, Handler>;

    this.http = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const proxy = PROXY_RE.exec(req.url ?? '');
      if (proxy) {
        if (!checkBearer(req.headers.authorization, readToken(this.cfg))) {
          res.writeHead(401).end();
          return;
        }
        handleProxyRequest(req, res, Number(proxy[1]), proxy[2] ?? '/');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const token = readToken(this.cfg);
    if (!token && !this.tokenWarned) {
      this.tokenWarned = true;
      console.error(`[wsd] no token configured (${this.cfg.tokenFile} / WSD_TOKEN); rejecting all connections`);
    }
    if (!checkBearer(req.headers.authorization, token)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://wsd');
    if (url.pathname === '/rpc') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onRpc(ws));
      return;
    }
    const proxy = PROXY_RE.exec(req.url ?? '');
    if (proxy) {
      handleProxyUpgrade(req, socket, head, Number(proxy[1]), proxy[2] ?? '/');
      return;
    }
    const m = /^\/term\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (m) {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.terminals.attach(m[1]!, ws));
      return;
    }
    rejectUpgrade(socket, 404, 'Not Found');
  }

  private onRpc(ws: WebSocket): void {
    this.rpcClients.add(ws);
    ws.on('close', () => this.rpcClients.delete(ws));
    ws.on('error', () => this.rpcClients.delete(ws));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      void this.onRpcMessage(ws, data.toString());
    });
  }

  private async onRpcMessage(ws: WebSocket, text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.send(ws, { jsonrpc: '2.0', id: null as unknown as number, error: { code: RpcErrorCode.ParseError, message: 'parse error' } });
      return;
    }
    if (Array.isArray(msg)) {
      const results = (await Promise.all(msg.map((m) => this.dispatch(m)))).filter((r): r is RpcResponse => r !== null);
      if (results.length) this.send(ws, results);
      return;
    }
    const res = await this.dispatch(msg);
    if (res) this.send(ws, res);
  }

  /** Handles one request; returns null for notifications (no id). */
  async dispatch(msg: unknown): Promise<RpcResponse | null> {
    const req = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = req && typeof req === 'object' && 'id' in req && (typeof req.id === 'string' || typeof req.id === 'number');
    const id = (hasId ? req.id : null) as number | string;
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: RpcErrorCode.InvalidRequest, message: 'invalid request' } };
    }
    const handler = Object.prototype.hasOwnProperty.call(this.handlers, req.method)
      ? this.handlers[req.method as WsdMethod]
      : undefined;
    if (!handler) {
      return hasId ? { jsonrpc: '2.0', id, error: { code: RpcErrorCode.MethodNotFound, message: `method not found: ${req.method}` } } : null;
    }
    const params = req.params === undefined || req.params === null ? {} : req.params;
    if (typeof params !== 'object' || Array.isArray(params)) {
      return { jsonrpc: '2.0', id, error: { code: RpcErrorCode.InvalidParams, message: 'params must be an object' } };
    }
    try {
      const result = await handler(params as Record<string, unknown>);
      return hasId ? { jsonrpc: '2.0', id, result } : null;
    } catch (err) {
      if (!(err instanceof WsdError) && !(err as NodeJS.ErrnoException)?.code) console.error(`[wsd] ${req.method} failed:`, err);
      return hasId ? { jsonrpc: '2.0', id, error: toRpcError(err) } : null;
    }
  }

  notify<K extends keyof WsdNotifications>(method: K, params: WsdNotifications[K]): void {
    const msg: RpcNotification<K, WsdNotifications[K]> = { jsonrpc: '2.0', method, params };
    const text = JSON.stringify(msg);
    for (const ws of this.rpcClients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        ws.terminate();
        this.rpcClients.delete(ws);
        continue;
      }
      ws.send(text);
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  async listen(): Promise<void> {
    fs.mkdirSync(this.cfg.root, { recursive: true });
    await this.ports.start();
    try {
      this.watcher.start();
    } catch (err) {
      console.error('[wsd] failed to start watcher:', err);
    }
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
  }

  async close(): Promise<void> {
    this.terminals.killAll();
    await this.agents.close();
    this.ports.stop();
    await this.watcher.stop();
    for (const ws of this.rpcClients) ws.close(1001, 'shutting down');
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
