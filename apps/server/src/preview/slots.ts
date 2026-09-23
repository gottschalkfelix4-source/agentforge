import { randomBytes } from 'node:crypto';

export const PREVIEW_TOKEN_TTL_MS = 60_000;

export interface SlotEntry {
  slot: number;
  projectId: string;
  port: number;
  createdAt: string;
  lastUsed: number;
}

interface TokenEntry {
  slot: number;
  projectId: string;
  port: number;
  expires: number;
}

/**
 * In-memory preview slot table (lost on restart; browsers simply request a new slot).
 * A slot maps to (project, container port). When all slots are taken the least recently used one is evicted.
 */
export class SlotTable {
  private readonly slots = new Map<number, SlotEntry>();
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly disabled = new Set<number>();

  constructor(readonly count: number, private readonly now: () => number = Date.now) {}

  /** Marks a slot as unusable (e.g. its host port could not be bound). */
  disable(slot: number) {
    this.disabled.add(slot);
    this.slots.delete(slot);
  }

  get usable(): number {
    return this.count - this.disabled.size;
  }

  get(slot: number): SlotEntry | undefined {
    return this.slots.get(slot);
  }

  list(projectId?: string): SlotEntry[] {
    return [...this.slots.values()].filter((s) => !projectId || s.projectId === projectId).sort((a, b) => a.slot - b.slot);
  }

  /**
   * Returns the slot for (project, port): reuses an existing one, otherwise takes a free one or evicts the LRU.
   * `evicted` is the previous occupant when a slot had to be taken over.
   */
  acquire(projectId: string, port: number): { entry: SlotEntry; created: boolean; evicted: SlotEntry | null } {
    for (const s of this.slots.values()) {
      if (s.projectId === projectId && s.port === port) {
        s.lastUsed = this.now();
        return { entry: s, created: false, evicted: null };
      }
    }
    let slot = -1;
    for (let i = 0; i < this.count; i++) {
      if (!this.disabled.has(i) && !this.slots.has(i)) {
        slot = i;
        break;
      }
    }
    let evicted: SlotEntry | null = null;
    if (slot < 0) {
      for (const s of this.slots.values()) if (!evicted || s.lastUsed < evicted.lastUsed) evicted = s;
      if (!evicted) throw new Error('Keine Vorschau-Slots verfügbar');
      slot = evicted.slot;
      this.release(slot);
    }
    const entry: SlotEntry = { slot, projectId, port, createdAt: new Date(this.now()).toISOString(), lastUsed: this.now() };
    this.slots.set(slot, entry);
    return { entry, created: true, evicted };
  }

  touch(slot: number) {
    const s = this.slots.get(slot);
    if (s) s.lastUsed = this.now();
  }

  release(slot: number): SlotEntry | undefined {
    const s = this.slots.get(slot);
    this.slots.delete(slot);
    for (const [t, e] of this.tokens) if (e.slot === slot) this.tokens.delete(t);
    return s;
  }

  /** Removes all slots of a project (e.g. when it was deleted). */
  releaseProject(projectId: string): SlotEntry[] {
    const out = this.list(projectId);
    for (const s of out) this.release(s.slot);
    return out;
  }

  /** One-time token (60 s) that lets the first browser request of a slot obtain the slot cookie. */
  issueToken(slot: number): string {
    const s = this.slots.get(slot);
    if (!s) throw new Error('unknown slot');
    this.prune();
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { slot, projectId: s.projectId, port: s.port, expires: this.now() + PREVIEW_TOKEN_TTL_MS });
    return token;
  }

  /** Consumes a token; valid only for the slot (and its current occupant) it was issued for. */
  consumeToken(token: string, slot: number): boolean {
    const e = this.tokens.get(token);
    if (!e) return false;
    this.tokens.delete(token);
    const s = this.slots.get(slot);
    return e.slot === slot && e.expires >= this.now() && !!s && s.projectId === e.projectId && s.port === e.port;
  }

  private prune() {
    const now = this.now();
    for (const [t, e] of this.tokens) if (e.expires < now) this.tokens.delete(t);
  }
}
