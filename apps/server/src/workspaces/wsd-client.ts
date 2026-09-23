import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { RpcResponse, WsdMethod, WsdMethods, WsdNotifications } from '@vibe/shared';
import type { WsdEndpoint } from '../docker/orchestrator.js';

const CALL_TIMEOUT_MS = 30_000;

/** Methods that routinely take longer (network-bound git, agent startup). */
const LONG_RUNNING: Partial<Record<WsdMethod, number>> = {
  'git.clone': 10 * 60_000,
  'git.push': 10 * 60_000,
  'git.pull': 10 * 60_000,
  'git.fetch': 10 * 60_000,
  'git.worktree.add': 5 * 60_000,
  'agent.start': 2 * 60_000,
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * JSON-RPC client for one workspace daemon. Reconnects with backoff until closed.
 * Emits 'notification' (method, params), 'open' and 'close'.
 */
export class WsdClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private backoff = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly resolveEndpoint: () => Promise<WsdEndpoint>, private readonly token: string) {
    super();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    this.closed = false;
    void this.open();
  }

  /** Resolves once connected, or rejects after the timeout. */
  waitOpen(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('open', onOpen);
        reject(new Error('Workspace-Daemon antwortet nicht'));
      }, timeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('open', onOpen);
    });
  }

  private async open() {
    if (this.closed) return;
    let url: string;
    try {
      const ep = await this.resolveEndpoint();
      url = `ws://${ep.host}:${ep.port}/rpc`;
    } catch {
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 500;
      this.emit('open');
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('error', () => {
      /* handled by close */
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Verbindung zum Workspace getrennt'));
        this.pending.delete(id);
      }
      this.emit('close');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }

  private onMessage(raw: string) {
    let msg: RpcResponse & { method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method && msg.id === undefined) {
      this.emit('notification', msg.method as keyof WsdNotifications, msg.params);
      return;
    }
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    if (msg.error) p.reject(new WsdError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }

  call<M extends WsdMethod>(
    method: M,
    params: WsdMethods[M][0],
    opts: { timeoutMs?: number } = {},
  ): Promise<WsdMethods[M][1]> {
    const timeoutMs = opts.timeoutMs ?? LONG_RUNNING[method] ?? CALL_TIMEOUT_MS;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new WsdError(-32000, 'Workspace ist nicht verbunden'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WsdError(-32001, `Zeitüberschreitung bei ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Opens a raw terminal stream to wsd (used by the browser bridge). */
  async openTerminal(termId: string): Promise<WebSocket> {
    const ep = await this.resolveEndpoint();
    return new WebSocket(`ws://${ep.host}:${ep.port}/term/${encodeURIComponent(termId)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

export class WsdError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}
