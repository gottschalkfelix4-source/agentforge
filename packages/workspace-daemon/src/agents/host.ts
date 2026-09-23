import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { startAgent, type AgentSessionHandle, type AgentStartOptions } from '@vibe/agent-adapters';
import type {
  AgentEvent,
  AgentSessionState,
  AgentStartParams,
  ImageInput,
  SessionEventRecord,
  SessionStatus,
  StructuredTransport,
  WsdNotifications,
} from '@vibe/shared';
import { PRIVATE_ENV_KEYS, VERSION } from '../config.js';
import { WsdError, invalidParams } from '../errors.js';
import { resolveLexical } from '../paths.js';

export const RING_SIZE = 5000;
/** Deltas of the same message / tool output arriving within this window are merged into one event. */
export const COALESCE_MS = 40;
/** How long agent.start waits for the handshake before returning (it continues in the background). */
export const START_WAIT_MS = 20_000;
/** Exited sessions are forgotten after this long (the app has persisted their events by then). */
export const EVICT_AFTER_MS = 60 * 60 * 1000;

type Notify = <K extends keyof WsdNotifications>(method: K, params: WsdNotifications[K]) => void;
export type Starter = (transport: StructuredTransport, opts: AgentStartOptions) => AgentSessionHandle;

type Mergeable = Extract<AgentEvent, { type: 'message.delta' }> | Extract<AgentEvent, { type: 'tool.update' }>;

interface Hosted {
  sessionId: string;
  agentId: string;
  handle: AgentSessionHandle | null;
  running: boolean;
  ready: boolean;
  stopping: boolean;
  busy: boolean;
  externalId: string | null;
  seq: number;
  ring: SessionEventRecord[];
  queue: { text: string; images?: ImageInput[] }[];
  approvals: Set<string>;
  status: SessionStatus | null;
  pending: { event: Mergeable; timer: NodeJS.Timeout } | null;
  exitedAt: number | null;
}

/** uid/gid of `coder` when wsd runs as root (normally the entrypoint already dropped privileges). */
function coderIds(): { uid: number; gid: number; home: string } | null {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  try {
    const line = fs
      .readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('coder:'));
    if (!line) return null;
    const parts = line.split(':');
    return { uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5] || '/home/coder' };
  } catch {
    return null;
  }
}

function agentEnv(extra: Record<string, string> | undefined, home?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !PRIVATE_ENV_KEYS.includes(k)) env[k] = v;
  }
  if (home) {
    env.HOME = home;
    env.USER = 'coder';
  }
  for (const [k, v] of Object.entries(extra ?? {})) if (typeof v === 'string') env[k] = v;
  return env;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw invalidParams(`${name} must be a non-empty string`);
  return v;
};

function isMergeable(e: AgentEvent): e is Mergeable {
  if (e.type === 'message.delta') return true;
  // Output-only tool updates (streamed command output).
  return e.type === 'tool.update' && e.output !== undefined && Object.keys(e).length === 3;
}

/**
 * Hosts structured agent processes inside the workspace so they keep running while the
 * app server is away. Every event gets a per-session monotonically increasing seq and is
 * kept in a ring buffer the app can backfill from (`agent.events`).
 */
export class AgentHost {
  private readonly sessions = new Map<string, Hosted>();
  private readonly evictTimer: NodeJS.Timeout;

  constructor(
    private readonly root: string,
    private readonly notify: Notify,
    private readonly starter: Starter = startAgent,
  ) {
    this.evictTimer = setInterval(() => this.evict(), 10 * 60 * 1000);
    this.evictTimer.unref();
  }

  // ---- events ------------------------------------------------------------------

  private record(s: Hosted, event: AgentEvent) {
    const rec: SessionEventRecord = { seq: ++s.seq, ts: new Date().toISOString(), event };
    s.ring.push(rec);
    if (s.ring.length > RING_SIZE) s.ring.splice(0, s.ring.length - RING_SIZE);
    this.notify('agent.event', { sessionId: s.sessionId, seq: rec.seq, ts: rec.ts, event });
  }

  private flush(s: Hosted) {
    const p = s.pending;
    if (!p) return;
    s.pending = null;
    clearTimeout(p.timer);
    this.record(s, p.event);
  }

  private emit(s: Hosted, event: AgentEvent) {
    if (isMergeable(event)) {
      const p = s.pending?.event;
      if (p && p.type === event.type && p.id === event.id) {
        if (p.type === 'message.delta' && event.type === 'message.delta' && p.role === event.role) {
          p.text += event.text;
          return;
        }
        if (p.type === 'tool.update' && event.type === 'tool.update') {
          p.output = (p.output ?? '') + (event.output ?? '');
          return;
        }
      }
      this.flush(s);
      s.pending = { event: { ...event }, timer: setTimeout(() => this.flush(s), COALESCE_MS) };
      return;
    }
    this.flush(s);
    this.record(s, event);
  }

  private setStatus(s: Hosted, status: SessionStatus, message?: string) {
    if (s.status === status && !message) return;
    s.status = status;
    this.emit(s, message ? { type: 'status', status, message } : { type: 'status', status });
  }

  private onAgentEvent(s: Hosted, handle: AgentSessionHandle, e: AgentEvent) {
    if (s.handle !== handle) return; // stale process
    switch (e.type) {
      case 'approval.request':
        s.approvals.add(e.id);
        this.emit(s, e);
        this.setStatus(s, 'awaiting_approval');
        return;
      case 'approval.resolved':
        s.approvals.delete(e.id);
        this.emit(s, e);
        if (s.busy && s.approvals.size === 0) this.setStatus(s, 'running');
        return;
      case 'turn.done':
        this.emit(s, e);
        s.busy = false;
        s.approvals.clear();
        if (s.running) {
          this.setStatus(s, 'idle');
          this.pump(s);
        }
        return;
      case 'session.info':
        s.externalId = e.externalId;
        this.emit(s, e);
        return;
      default:
        this.emit(s, e);
    }
  }

  private onAgentExit(s: Hosted, handle: AgentSessionHandle, code: number | null, message?: string) {
    if (s.handle !== handle) return;
    s.running = false;
    s.ready = false;
    s.busy = false;
    s.queue = [];
    s.approvals.clear();
    s.exitedAt = Date.now();
    if (s.stopping) this.setStatus(s, 'stopped');
    else if (code === 0) this.setStatus(s, 'stopped', 'Agent hat sich beendet');
    else {
      const msg = message ?? `Agent-Prozess beendet (Code ${code})`;
      this.emit(s, { type: 'error', message: msg });
      this.setStatus(s, 'error', msg);
    }
    this.flush(s);
    this.notify('agent.exit', { sessionId: s.sessionId, code, ...(message && !s.stopping ? { message } : {}) });
  }

  private pump(s: Hosted) {
    if (!s.running || !s.ready || s.busy || !s.handle) return;
    const item = s.queue.shift();
    if (!item) return;
    const handle = s.handle;
    s.busy = true;
    this.emit(s, { type: 'user.message', id: randomUUID(), text: item.text, ...(item.images?.length ? { images: item.images } : {}) });
    this.emit(s, { type: 'turn.start' });
    this.setStatus(s, 'running');
    handle.prompt(item.text, item.images).catch((err: Error) => {
      if (s.handle !== handle || !s.busy) return;
      this.emit(s, { type: 'error', message: err.message });
      this.onAgentEvent(s, handle, { type: 'turn.done', stopReason: 'error' });
    });
  }

  private require(sessionId: unknown): Hosted {
    const s = this.sessions.get(str(sessionId, 'sessionId'));
    if (!s) throw new WsdError('ENOENT', `unbekannte Sitzung ${String(sessionId)}`);
    return s;
  }

  private requireRunning(sessionId: unknown): Hosted & { handle: AgentSessionHandle } {
    const s = this.require(sessionId);
    if (!s.running || !s.handle) throw new WsdError('ENOTRUNNING', 'Der Agent dieser Sitzung läuft nicht');
    return s as Hosted & { handle: AgentSessionHandle };
  }

  // ---- RPC methods -----------------------------------------------------------------

  async start(p: AgentStartParams): Promise<{ externalId: string | null }> {
    const sessionId = str(p.sessionId, 'sessionId');
    const command = str(p.command, 'command');
    if (p.transport !== 'acp' && p.transport !== 'codex_app_server') throw invalidParams('transport must be acp or codex_app_server');
    if (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string')) throw invalidParams('args must be a string[]');
    const cwd = resolveLexical(this.root, p.cwd || '.');
    if (!fs.existsSync(cwd)) throw new WsdError('ENOENT', `Arbeitsverzeichnis existiert nicht: ${p.cwd}`);

    let s = this.sessions.get(sessionId);
    if (s?.running) throw new WsdError('EBUSY', 'Der Agent dieser Sitzung läuft bereits');
    if (!s) {
      s = {
        sessionId,
        agentId: p.agentId,
        handle: null,
        running: false,
        ready: false,
        stopping: false,
        busy: false,
        externalId: null,
        seq: 0,
        ring: [],
        queue: [],
        approvals: new Set(),
        status: null,
        pending: null,
        exitedAt: null,
      };
      this.sessions.set(sessionId, s);
    }
    const hs = s;
    hs.seq = Math.max(hs.seq, typeof p.startSeq === 'number' && p.startSeq > 0 ? Math.floor(p.startSeq) : 0);
    hs.agentId = p.agentId;
    hs.running = true;
    hs.ready = false;
    hs.stopping = false;
    hs.busy = false;
    hs.queue = [];
    hs.approvals.clear();
    hs.exitedAt = null;
    hs.status = null;
    this.setStatus(hs, 'starting');

    const ids = coderIds();
    let handle: AgentSessionHandle;
    try {
      handle = this.starter(p.transport, {
        command,
        args: p.args,
        cwd,
        env: agentEnv(p.env, ids?.home),
        model: p.model ?? null,
        mode: p.mode ?? null,
        mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
        resumeExternalId: p.resumeExternalId ?? null,
        clientName: 'agentforge',
        clientVersion: VERSION,
        ...(ids ? { uid: ids.uid, gid: ids.gid } : {}),
      });
    } catch (err) {
      hs.running = false;
      hs.exitedAt = Date.now();
      const msg = `Agent konnte nicht gestartet werden: ${(err as Error).message}`;
      this.emit(hs, { type: 'error', message: msg });
      this.setStatus(hs, 'error', msg);
      this.flush(hs);
      throw new WsdError('ESPAWN', msg);
    }
    hs.handle = handle;
    handle.onEvent((e) => this.onAgentEvent(hs, handle, e));
    handle.onExit((code, message) => this.onAgentExit(hs, handle, code, message));

    const onReady = () => {
      if (hs.handle !== handle || !hs.running) return;
      hs.ready = true;
      hs.externalId = handle.externalId ?? hs.externalId;
      this.setStatus(hs, 'idle');
      this.pump(hs);
    };
    const onFail = (err: Error) => {
      if (hs.handle !== handle) return;
      const msg = err.message;
      if (hs.running) {
        // Detach first so the exit handler of the disposed process is ignored (status stays `error`).
        hs.handle = null;
        hs.running = false;
        hs.exitedAt = Date.now();
        hs.queue = [];
        this.emit(hs, { type: 'error', message: msg });
        this.setStatus(hs, 'error', msg);
        this.flush(hs);
        void handle.dispose();
        this.notify('agent.exit', { sessionId: hs.sessionId, code: null, message: msg });
      }
      return msg;
    };

    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      handle.ready.then(
        () => ({ ok: true as const }),
        (err: Error) => ({ ok: false as const, err }),
      ),
      new Promise<{ ok: 'pending' }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: 'pending' }), START_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (outcome.ok === true) {
      onReady();
      return { externalId: handle.externalId };
    }
    if (outcome.ok === false) {
      throw new WsdError('EAGENT', onFail(outcome.err) ?? outcome.err.message);
    }
    // Still handshaking (slow first start, e.g. npx download): continue in the background.
    handle.ready.then(onReady, onFail);
    return { externalId: null };
  }

  prompt(p: { sessionId: string; text: string; images?: ImageInput[] }): { ok: true } {
    const s = this.requireRunning(p.sessionId);
    if (typeof p.text !== 'string') throw invalidParams('text must be a string');
    const images = Array.isArray(p.images) ? p.images.filter((i) => i && typeof i.data === 'string' && typeof i.mime === 'string') : undefined;
    s.queue.push({ text: p.text, ...(images?.length ? { images } : {}) });
    this.pump(s);
    return { ok: true };
  }

  async cancel(p: { sessionId: string }): Promise<{ ok: true }> {
    const s = this.requireRunning(p.sessionId);
    s.queue = [];
    await s.handle.cancel();
    return { ok: true };
  }

  respond(p: { sessionId: string; requestId: string; optionId: string }): { ok: true } {
    const s = this.requireRunning(p.sessionId);
    try {
      s.handle.respondApproval(str(p.requestId, 'requestId'), str(p.optionId, 'optionId'));
    } catch (err) {
      if (err instanceof WsdError) throw err;
      throw new WsdError('ENOENT', (err as Error).message);
    }
    return { ok: true };
  }

  async setMode(p: { sessionId: string; value: string }): Promise<{ ok: true }> {
    const s = this.requireRunning(p.sessionId);
    if (!s.handle.setMode) throw new WsdError('ENOTSUP', 'Der Agent unterstützt keine Modi');
    await s.handle.ready;
    await s.handle.setMode(str(p.value, 'value'));
    return { ok: true };
  }

  async setModel(p: { sessionId: string; value: string }): Promise<{ ok: true }> {
    const s = this.requireRunning(p.sessionId);
    if (!s.handle.setModel) throw new WsdError('ENOTSUP', 'Der Agent unterstützt keine Modellwahl');
    await s.handle.ready;
    await s.handle.setModel(str(p.value, 'value'));
    return { ok: true };
  }

  async stop(p: { sessionId: string }): Promise<{ ok: true }> {
    const s = this.sessions.get(str(p.sessionId, 'sessionId'));
    if (!s?.handle || !s.running) return { ok: true };
    s.stopping = true;
    s.queue = [];
    await s.handle.dispose();
    return { ok: true };
  }

  list(): AgentSessionState[] {
    return [...this.sessions.values()].map((s) => ({ sessionId: s.sessionId, running: s.running, lastSeq: s.seq, externalId: s.externalId }));
  }

  events(p: { sessionId: string; since: number }): SessionEventRecord[] {
    const s = this.sessions.get(str(p.sessionId, 'sessionId'));
    if (!s) return [];
    this.flush(s);
    const since = typeof p.since === 'number' ? p.since : 0;
    return s.ring.filter((r) => r.seq > since);
  }

  private evict() {
    const cutoff = Date.now() - EVICT_AFTER_MS;
    for (const [id, s] of this.sessions) if (!s.running && s.exitedAt && s.exitedAt < cutoff) this.sessions.delete(id);
  }

  async close(): Promise<void> {
    clearInterval(this.evictTimer);
    await Promise.all(
      [...this.sessions.values()].map(async (s) => {
        if (s.handle && s.running) {
          s.stopping = true;
          await s.handle.dispose().catch(() => undefined);
        }
      }),
    );
  }
}
