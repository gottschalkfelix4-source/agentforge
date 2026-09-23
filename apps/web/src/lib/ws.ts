import type { Channel, ClientMessage, ServerEvent, ServerMessage } from '@vibe/shared';

type Listener = (ev: ServerEvent, ch: Channel) => void;
type StateListener = (connected: boolean) => void;

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

/** Single shared control socket (`/ws`) with auto-reconnect and ref-counted subscriptions. */
class ControlSocket {
  private ws: WebSocket | null = null;
  private subs = new Map<Channel, number>();
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  connected = false;

  start() {
    if (this.active) return;
    this.active = true;
    this.open();
  }

  stop() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setConnected(false);
  }

  private open() {
    if (!this.active) return;
    const ws = new WebSocket(wsUrl('/ws'));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      for (const ch of this.subs.keys()) this.send({ t: 'sub', ch });
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'ping') {
        this.send({ t: 'pong' });
      } else if (msg.t === 'ev') {
        for (const l of this.listeners) {
          try {
            l(msg.e, msg.ch);
          } catch (err) {
            console.error('[ws] listener error', err);
          }
        }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (!this.active) return;
    const delay = Math.min(10_000, 500 * 2 ** this.retry) + Math.random() * 250;
    this.retry++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    for (const l of this.stateListeners) l(v);
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  subscribe(ch: Channel): () => void {
    const n = this.subs.get(ch) ?? 0;
    this.subs.set(ch, n + 1);
    if (n === 0) this.send({ t: 'sub', ch });
    return () => {
      const cur = this.subs.get(ch) ?? 0;
      if (cur <= 1) {
        this.subs.delete(ch);
        this.send({ t: 'unsub', ch });
      } else {
        this.subs.set(ch, cur - 1);
      }
    };
  }

  onEvent(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onState(l: StateListener): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }
}

export const controlSocket = new ControlSocket();
