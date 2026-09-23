import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentEvent, ImageInput } from '@vibe/shared';
import { JsonRpcProcess } from './jsonrpc.js';
import type { AgentEventListener, AgentExitListener, AgentSessionHandle, AgentStartOptions } from './types.js';

type SessionInfo = Extract<AgentEvent, { type: 'session.info' }>;

export const newId = () => randomUUID();

/** Shared plumbing: listeners, process lifecycle, message accumulation, session info snapshot. */
export abstract class BaseSession implements AgentSessionHandle {
  readonly rpc: JsonRpcProcess;
  readonly ready: Promise<void>;
  externalId: string | null = null;
  protected readonly opts: AgentStartOptions;
  private readonly eventListeners = new Set<AgentEventListener>();
  private readonly exitListeners = new Set<AgentExitListener>();
  private disposed = false;
  /** Open streamed messages by role (closed with message.done on role switch / tool / turn end). */
  private readonly openMessages = new Map<'assistant' | 'thought', { id: string; text: string }>();
  protected info: Omit<SessionInfo, 'type' | 'externalId'> = {};
  private lastInfo = '';

  constructor(opts: AgentStartOptions) {
    this.opts = opts;
    this.rpc = new JsonRpcProcess({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      uid: opts.uid,
      gid: opts.gid,
    });
    if (opts.onStderr) this.rpc.onStderr = opts.onStderr;
    this.rpc.onExit((code, signal, err) => {
      this.onProcessExit();
      const message = err
        ? `Agent konnte nicht gestartet werden: ${err.message}`
        : this.disposed
          ? undefined
          : `Agent-Prozess beendet (${signal ?? `Code ${code}`})${this.rpc.stderrTail(5) ? `: ${this.rpc.stderrTail(5)}` : ''}`;
      for (const fn of this.exitListeners) fn(err ? 127 : code, message);
    });
    const timeout = opts.startTimeoutMs ?? 120_000;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Zeitüberschreitung beim Start des Agents')), timeout);
      timer.unref();
      const offExit = this.rpc.onExit((code, signal, err) =>
        reject(new Error(err ? `Agent konnte nicht gestartet werden: ${err.message}` : `Agent-Prozess beim Start beendet (${signal ?? `Code ${code}`})${this.rpc.stderrTail(8) ? `:\n${this.rpc.stderrTail(8)}` : ''}`)),
      );
      // Defer so subclass fields are initialised before the handshake runs.
      queueMicrotask(() => {
        this.handshake().then(
          () => {
            clearTimeout(timer);
            offExit();
            resolve();
          },
          (e: Error) => {
            clearTimeout(timer);
            offExit();
            reject(e);
          },
        );
      });
    });
    // Avoid unhandled rejections when nobody awaits `ready`.
    this.ready.catch(() => undefined);
  }

  protected abstract handshake(): Promise<void>;
  abstract prompt(text: string, images?: ImageInput[]): Promise<void>;
  abstract cancel(): Promise<void>;
  abstract respondApproval(requestId: string, optionId: string): void;

  /** Hook for subclasses (e.g. resolve pending approvals). */
  protected onProcessExit(): void {}

  onEvent(cb: AgentEventListener): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onExit(cb: AgentExitListener): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  protected emit(e: AgentEvent) {
    for (const fn of this.eventListeners) {
      try {
        fn(e);
      } catch {
        /* listener errors must not break the protocol loop */
      }
    }
  }

  /** Appends streamed text to the open message of `role`, opening one if needed. */
  protected delta(role: 'assistant' | 'thought', text: string, id?: string | null) {
    if (!text) return;
    let open = this.openMessages.get(role);
    if (open && id && open.id !== id) {
      this.closeMessage(role);
      open = undefined;
    }
    // A switch between thinking and answering closes the other message.
    this.closeMessage(role === 'assistant' ? 'thought' : 'assistant');
    if (!open) {
      open = { id: id || newId(), text: '' };
      this.openMessages.set(role, open);
    }
    open.text += text;
    this.emit({ type: 'message.delta', id: open.id, role, text });
  }

  /** Emits message.done for an open message. `finalText` overrides the accumulated text. */
  protected closeMessage(role: 'assistant' | 'thought', finalText?: string) {
    const open = this.openMessages.get(role);
    if (!open) return;
    this.openMessages.delete(role);
    this.emit({ type: 'message.done', id: open.id, role, text: finalText ?? open.text });
  }

  protected closeMessages() {
    this.closeMessage('thought');
    this.closeMessage('assistant');
  }

  protected openMessageId(role: 'assistant' | 'thought'): string | undefined {
    return this.openMessages.get(role)?.id;
  }

  /** Emits the full session.info snapshot after merging `patch`. */
  protected updateInfo(patch: Partial<Omit<SessionInfo, 'type' | 'externalId'>>) {
    this.info = { ...this.info, ...patch };
    if (!this.externalId) return;
    const ev: SessionInfo = { type: 'session.info', externalId: this.externalId, ...this.info };
    const key = JSON.stringify(ev);
    if (key === this.lastInfo) return;
    this.lastInfo = key;
    this.emit(ev);
  }

  /** Path relative to the session cwd when inside it, else unchanged. */
  protected rel(p: string): string {
    if (!path.isAbsolute(p)) return p;
    const r = path.relative(this.opts.cwd, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.rpc.kill();
  }
}
