// Minimal JSON-RPC 2.0 peer over newline-delimited JSON (stdio of a child process).
// Both ACP and the Codex app-server speak exactly this framing.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type RpcId = number | string;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    // Agents often answer a generic "Internal error" and put the real cause (e.g. the model API's error) into data.
    const detail = rpcErrorDetail(data);
    super(detail && !message.includes(detail) ? `${message}: ${detail}` : message);
    this.name = 'RpcError';
  }
}

/** Readable text from a JSON-RPC error's `data` (string, `{details}`/`{message}`, else compact JSON). */
export function rpcErrorDetail(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  let text: string;
  if (typeof data === 'string') text = data;
  else if (typeof data === 'object') {
    const d = data as { details?: unknown; message?: unknown; error?: unknown };
    const pick = [d.details, d.message, d.error].find((v) => typeof v === 'string' && v.trim());
    text = typeof pick === 'string' ? pick : JSON.stringify(data);
  } else text = String(data);
  text = text.trim();
  if (!text || text === '{}') return null;
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

type RequestHandler = (method: string, params: unknown, id: RpcId) => unknown | Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
}

const STDERR_KEEP = 40;

/**
 * Spawns `command args` and speaks JSON-RPC over its stdin/stdout.
 * Incoming requests go to `onRequest`, notifications to `onNotification`.
 */
export class JsonRpcProcess {
  readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly stderrLines: string[] = [];
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null, err?: Error) => void>();
  onRequest: RequestHandler = (method) => {
    throw new RpcError(-32601, `method not found: ${method}`);
  };
  onNotification: NotificationHandler = () => {};
  /** Called for every stderr line (debugging). */
  onStderr: (line: string) => void = () => {};

  constructor(spec: SpawnSpec) {
    const opts: SpawnOptions = {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so dispose() can take down the whole tree.
      detached: process.platform !== 'win32',
    };
    if (spec.uid !== undefined) opts.uid = spec.uid;
    if (spec.gid !== undefined) opts.gid = spec.gid;
    this.child = spawn(spec.command, spec.args, opts);

    const outDecoder = new StringDecoder('utf8');
    let buf = '';
    this.child.stdout!.on('data', (chunk: Buffer) => {
      buf += outDecoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });

    const errDecoder = new StringDecoder('utf8');
    let ebuf = '';
    this.child.stderr!.on('data', (chunk: Buffer) => {
      ebuf += errDecoder.write(chunk);
      let nl: number;
      while ((nl = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, nl).replace(/\r$/, '');
        ebuf = ebuf.slice(nl + 1);
        if (!line.trim()) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > STDERR_KEEP) this.stderrLines.shift();
        this.onStderr(line);
      }
    });

    this.child.stdin!.on('error', () => {
      /* EPIPE after exit — surfaced via 'exit' */
    });
    this.child.on('error', (err) => this.finish(null, null, err));
    this.child.on('exit', (code, signal) => this.finish(code, signal));
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Last lines the process wrote to stderr (for error messages). */
  stderrTail(n = 10): string {
    return this.stderrLines.slice(-n).join('\n');
  }

  onExit(fn: (code: number | null, signal: NodeJS.Signals | null, err?: Error) => void): () => void {
    if (this.exitInfo) {
      queueMicrotask(() => fn(this.exitInfo!.code, this.exitInfo!.signal));
      return () => {};
    }
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, err?: Error) {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    const tail = this.stderrTail(5);
    const reason = err
      ? `Agent konnte nicht gestartet werden: ${err.message}`
      : `Agent-Prozess beendet (${signal ?? `Code ${code}`})${tail ? `: ${tail}` : ''}`;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new RpcError(-32099, reason));
    }
    for (const fn of this.exitListeners) fn(code, signal, err);
    this.exitListeners.clear();
  }

  private write(msg: unknown) {
    if (this.exited || !this.child.stdin!.writable) return;
    this.child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.exited) return Promise.reject(new RpcError(-32099, 'Agent-Prozess läuft nicht'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(-32001, `Zeitüberschreitung bei ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  private onLine(line: string) {
    let msg: { id?: RpcId | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      // Some CLIs print banners on stdout; ignore anything that isn't JSON.
      this.onStderr(`[stdout] ${line}`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) void this.handleRequest(msg.id, msg.method, msg.params);
      else {
        try {
          this.onNotification(msg.method, msg.params);
        } catch (err) {
          this.onStderr(`[notification handler] ${(err as Error).message}`);
        }
      }
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message || `${p.method} fehlgeschlagen`, msg.error.data));
    else p.resolve(msg.result);
  }

  private async handleRequest(id: RpcId, method: string, params: unknown) {
    try {
      const result = await this.onRequest(method, params, id);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      const e = err as RpcError;
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: typeof e.code === 'number' ? e.code : -32603, message: e.message ?? String(err), ...(e.data !== undefined ? { data: e.data } : {}) },
      });
    }
  }

  /** SIGTERM the process group, SIGKILL after `graceMs`. Resolves once exited. */
  kill(graceMs = 3000): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.onExit(done);
      const sig = (s: NodeJS.Signals) => {
        const pid = this.child.pid;
        try {
          if (pid && process.platform !== 'win32') process.kill(-pid, s);
          else this.child.kill(s);
        } catch {
          try {
            this.child.kill(s);
          } catch {
            /* gone */
          }
        }
      };
      try {
        this.child.stdin!.end();
      } catch {
        /* ignore */
      }
      sig('SIGTERM');
      const timer = setTimeout(() => sig('SIGKILL'), graceMs);
      timer.unref();
    });
  }
}
