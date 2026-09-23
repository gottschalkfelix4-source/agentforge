import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawn, type IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { TermControl, TermCreateParams, TerminalInfo } from '@vibe/shared';
import { PRIVATE_ENV_KEYS } from './config.js';
import { WsdError, invalidParams } from './errors.js';
import { resolveLexical } from './paths.js';
import { Scrollback } from './scrollback.js';

export const SCROLLBACK_CAP = 2 * 1024 * 1024;
export const MAX_BUFFERED = 8 * 1024 * 1024;
const TITLE_POLL_MS = 1500;

interface Terminal {
  info: TerminalInfo;
  pty: IPty;
  scrollback: Scrollback;
  clients: Set<WebSocket>;
  explicitTitle: boolean;
  lastProcess: string;
}

export interface TerminalEvents {
  onExit(id: string, exitCode: number | null): void;
  onTitle(id: string, title: string): void;
}

function newId(): string {
  return randomBytes(6).toString('base64url');
}

function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

function clampDim(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, 1), max);
}

function childEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !PRIVATE_ENV_KEYS.includes(k)) env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

function sendControl(ws: WebSocket, msg: TermControl): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export class TerminalManager {
  private terms = new Map<string, Terminal>();
  private titleTimer: NodeJS.Timeout;

  constructor(
    private readonly root: string,
    private readonly events: TerminalEvents,
  ) {
    this.titleTimer = setInterval(() => this.pollTitles(), TITLE_POLL_MS);
    this.titleTimer.unref();
  }

  create(params: TermCreateParams = {}): TerminalInfo {
    if (params.command !== undefined && typeof params.command !== 'string') throw invalidParams('command must be a string');
    if (params.args !== undefined && (!Array.isArray(params.args) || params.args.some((a) => typeof a !== 'string'))) {
      throw invalidParams('args must be a string[]');
    }
    const command = params.command || defaultShell();
    const args = params.args ?? (params.command ? [] : process.platform === 'win32' ? [] : ['-l']);
    const cwd = params.cwd ? resolveLexical(this.root, params.cwd) : path.resolve(this.root);
    if (!fs.existsSync(cwd)) throw new WsdError('ENOENT', `cwd does not exist: ${params.cwd}`);
    const cols = clampDim(params.cols, 80, 1000);
    const rows = clampDim(params.rows, 24, 500);

    let p: IPty;
    try {
      p = spawn(command, args, { name: 'xterm-256color', cols, rows, cwd, env: childEnv(params.env) });
    } catch (err) {
      throw new WsdError('ESPAWN', `failed to start ${command}: ${(err as Error).message}`);
    }

    const id = newId();
    const explicitTitle = typeof params.title === 'string' && params.title.length > 0;
    const info: TerminalInfo = {
      id,
      title: explicitTitle ? params.title! : path.basename(command),
      cwd: path.relative(path.resolve(this.root), cwd).split(path.sep).join('/') || '.',
      command,
      args,
      pid: p.pid,
      exited: false,
      exitCode: null,
      createdAt: new Date().toISOString(),
    };
    const term: Terminal = {
      info,
      pty: p,
      scrollback: new Scrollback(SCROLLBACK_CAP),
      clients: new Set(),
      explicitTitle,
      lastProcess: '',
    };
    this.terms.set(id, term);

    p.onData((data) => {
      const buf = Buffer.from(data, 'utf8');
      term.scrollback.push(buf);
      for (const ws of term.clients) this.sendBinary(term, ws, buf);
    });
    p.onExit(({ exitCode, signal }) => {
      info.exited = true;
      // Killed by a signal → shell convention 128+signo.
      info.exitCode = signal ? 128 + signal : (exitCode ?? null);
      for (const ws of term.clients) {
        sendControl(ws, { type: 'exit', exitCode: info.exitCode });
        ws.close(1000, 'exited');
      }
      term.clients.clear();
      this.events.onExit(id, info.exitCode);
    });
    return { ...info };
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info }));
  }

  get(id: string): TerminalInfo | undefined {
    const t = this.terms.get(id);
    return t ? { ...t.info } : undefined;
  }

  kill(id: string): void {
    const t = this.require(id);
    this.terms.delete(id);
    if (!t.info.exited) {
      try {
        t.pty.kill();
      } catch {
        /* already gone */
      }
      // Escalate if the process ignores SIGHUP.
      const pid = t.info.pid;
      setTimeout(() => {
        if (!t.info.exited && pid && process.platform !== 'win32') {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }, 3000).unref();
    }
    for (const ws of t.clients) {
      sendControl(ws, { type: 'exit', exitCode: t.info.exitCode });
      ws.close(1000, 'killed');
    }
    t.clients.clear();
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const t = this.require(id);
    if (t.info.exited) return;
    try {
      t.pty.resize(clampDim(cols, 80, 1000), clampDim(rows, 24, 500));
    } catch {
      /* pty may have just exited */
    }
  }

  /** Attaches a /term/<id> websocket client. */
  attach(id: string, ws: WebSocket): void {
    const t = this.terms.get(id);
    if (!t) {
      sendControl(ws, { type: 'error', message: `unknown terminal ${id}` });
      ws.close(4404, 'unknown terminal');
      return;
    }
    ws.send(t.scrollback.snapshot(), { binary: true });
    if (t.info.exited) {
      sendControl(ws, { type: 'exit', exitCode: t.info.exitCode });
      ws.close(1000, 'exited');
      return;
    }
    t.clients.add(ws);
    // Per-client decoder so UTF-8 sequences split across frames stay intact.
    const decoder = new StringDecoder('utf8');
    ws.on('message', (data, isBinary) => {
      if (t.info.exited) return;
      if (isBinary) {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(new Uint8Array(data));
        const text = decoder.write(buf);
        if (text) t.pty.write(text);
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const m = msg as Partial<TermControl>;
      if (m && m.type === 'resize') this.resize(id, (m as { cols?: unknown }).cols, (m as { rows?: unknown }).rows);
    });
    const detach = () => t.clients.delete(ws);
    ws.on('close', detach);
    ws.on('error', detach);
  }

  private sendBinary(t: Terminal, ws: WebSocket, buf: Buffer): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      t.clients.delete(ws);
      ws.terminate();
      return;
    }
    ws.send(buf, { binary: true });
  }

  private require(id: unknown): Terminal {
    if (typeof id !== 'string') throw invalidParams('id must be a string');
    const t = this.terms.get(id);
    if (!t) throw new WsdError('ENOENT', `unknown terminal ${id}`);
    return t;
  }

  private pollTitles(): void {
    for (const t of this.terms.values()) {
      if (t.explicitTitle || t.info.exited) continue;
      let proc: string;
      try {
        proc = t.pty.process;
      } catch {
        continue;
      }
      if (!proc || proc === t.lastProcess) continue;
      t.lastProcess = proc;
      const title = path.basename(proc);
      if (title !== t.info.title) {
        t.info.title = title;
        this.events.onTitle(t.info.id, title);
      }
    }
  }

  killAll(): void {
    clearInterval(this.titleTimer);
    for (const t of this.terms.values()) {
      if (!t.info.exited) {
        try {
          t.pty.kill();
        } catch {
          /* ignore */
        }
      }
      for (const ws of t.clients) ws.close(1001, 'shutting down');
    }
  }
}
