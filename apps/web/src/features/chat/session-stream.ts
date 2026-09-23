import * as React from 'react';
import type { ServerEvent, SessionEventRecord } from '@vibe/shared';
import { controlSocket } from '@/lib/ws';
import { chatApi } from './api';
import { emptyTranscript, ingest, type TranscriptState } from './transcript';

/**
 * Live transcript of one session: initial load via REST, live `session.event`s via the control socket,
 * gap-fill on seq holes and on reconnect. Streams are cached (LRU) so switching sessions is instant.
 */
class SessionStream {
  state: TranscriptState = emptyTranscript();
  error: string | null = null;
  private listeners = new Set<() => void>();
  private refs = 0;
  private offs: (() => void)[] = [];
  private fetching = false;
  private refetch = false;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private live: SessionEventRecord[] = [];
  private raf: number | null = null;

  constructor(readonly sid: string) {}

  get active() {
    return this.refs > 0;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  private set(next: TranscriptState) {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  attach() {
    this.refs++;
    if (this.refs > 1) return;
    const ch = `session:${this.sid}` as const;
    this.offs.push(controlSocket.subscribe(ch));
    this.offs.push(
      controlSocket.onEvent((ev: ServerEvent) => {
        if (ev.type !== 'session.event' || ev.sessionId !== this.sid) return;
        this.live.push({ seq: ev.seq, ts: ev.ts, event: ev.event });
        this.scheduleFlush();
      }),
    );
    this.offs.push(
      controlSocket.onState((connected) => {
        if (connected) void this.fetch();
      }),
    );
    void this.fetch();
  }

  detach() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    for (const off of this.offs.splice(0)) off();
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  /** Coalesce bursts of live events (token deltas) into one state update per frame. */
  private scheduleFlush() {
    if (this.raf !== null) return;
    const run = () => {
      this.raf = null;
      const batch = this.live.splice(0);
      if (batch.length === 0) return;
      this.set(ingest(this.state, batch));
      if (this.state.gap) this.scheduleGapFill();
    };
    this.raf = typeof requestAnimationFrame === 'function' && !document.hidden
      ? requestAnimationFrame(run)
      : (setTimeout(run, 16) as unknown as number);
  }

  private scheduleGapFill() {
    if (this.gapTimer) return;
    // give reordered websocket messages a moment before hitting the API
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.state.gap) void this.fetch();
    }, 300);
  }

  async fetch() {
    if (this.fetching) {
      this.refetch = true;
      return;
    }
    this.fetching = true;
    try {
      do {
        this.refetch = false;
        const since = this.state.lastSeq;
        const records = await chatApi.events(this.sid, since >= 0 ? since : undefined);
        this.error = null;
        this.set(ingest(this.state, records, { settle: true }));
      } while (this.refetch);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      // make sure the UI does not stay in "loading"
      if (!this.state.loaded) this.set({ ...this.state, loaded: true });
      else for (const l of this.listeners) l();
    } finally {
      this.fetching = false;
    }
  }
}

const cache = new Map<string, SessionStream>();
const MAX_CACHED = 12;

function getStream(sid: string): SessionStream {
  let st = cache.get(sid);
  if (st) {
    // LRU bump
    cache.delete(sid);
    cache.set(sid, st);
    return st;
  }
  st = new SessionStream(sid);
  cache.set(sid, st);
  if (cache.size > MAX_CACHED) {
    for (const [k, v] of cache) {
      if (cache.size <= MAX_CACHED) break;
      if (k !== sid && !v.active) cache.delete(k);
    }
  }
  return st;
}

export function dropSessionStream(sid: string) {
  const st = cache.get(sid);
  if (st) st.detach();
  cache.delete(sid);
}

const EMPTY = emptyTranscript();
const noop = () => () => {};

/** Subscribe to a session transcript (null = none). */
export function useTranscript(sid: string | undefined): { state: TranscriptState; error: string | null; reload: () => void } {
  const stream = React.useMemo(() => (sid ? getStream(sid) : null), [sid]);
  React.useEffect(() => {
    if (!stream) return;
    stream.attach();
    return () => stream.detach();
  }, [stream]);
  const state = React.useSyncExternalStore(stream?.subscribe ?? noop, stream?.getSnapshot ?? (() => EMPTY));
  const reload = React.useCallback(() => void stream?.fetch(), [stream]);
  return { state, error: stream?.error ?? null, reload };
}
