// Pure events → view-model reducer for the structured agent chat.
//
// Design:
// - Records are ingested in batches (initial load, gap fill, single live events). Each batch copies the
//   touched turns/items at most once ("copy-on-first-write" per batch), so loading thousands of events is
//   O(n) and untouched rows keep their identity (memoized rows skip re-rendering).
// - Dedupe/ordering by `seq`: records with seq <= lastSeq are dropped; records beyond lastSeq+1 are
//   buffered in `pending` until the gap is filled (`gap` = true signals the caller to fetch
//   `events?since=lastSeq`). `settle: true` (used after a fetch returned) drains the buffer even if the
//   server has holes, so the UI never stalls.
// - The transcript is grouped into turns. A turn starts with `user.message` (or `turn.start` after a
//   finished turn) and carries its items plus the latest plan, usage and turn diff.

import type {
  AgentEvent,
  FileDiff,
  ImageInput,
  PlanEntry,
  QuestionAnswers,
  QuestionField,
  SessionEventRecord,
  SessionStatus,
  ToolKind,
  ToolStatus,
} from '@vibe/shared';

/** Cap for tool output kept in memory (tail is kept). */
export const MAX_TOOL_OUTPUT = 200_000;

export interface UserItem {
  kind: 'user';
  key: string;
  id: string;
  text: string;
  images?: ImageInput[];
}

export interface MessageItem {
  kind: 'message';
  key: string;
  id: string;
  role: 'assistant' | 'thought';
  text: string;
  done: boolean;
  /** Event timestamps (ms) of the first delta and of completion — used for "Nachgedacht für N s". */
  startedAt?: number;
  endedAt?: number;
  /** Duration reported by the agent adapter (survives history compaction). */
  durationMs?: number;
  /** Sub-agent (tool id) that wrote this message — rendered inside its card. */
  parentId?: string;
}

export interface ToolItem {
  kind: 'tool';
  key: string;
  id: string;
  toolKind: ToolKind;
  title: string;
  status: ToolStatus;
  input?: unknown;
  locations?: string[];
  output: string;
  outputTruncated: boolean;
  diffs?: FileDiff[];
  /** Sub-agent (tool id) that made this call — rendered inside its card. */
  parentId?: string;
  /** Event timestamps (ms) of start and completion (sub-agent duration). */
  startedAt?: number;
  endedAt?: number;
}

export interface ApprovalItem {
  kind: 'approval';
  key: string;
  id: string;
  toolId?: string;
  approvalKind: 'exec' | 'edit' | 'other';
  title: string;
  detail?: string;
  diffs?: FileDiff[];
  options: { id: string; label: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
  resolvedOptionId: string | null;
}

export interface QuestionItem {
  kind: 'question';
  key: string;
  id: string;
  toolId?: string;
  message: string;
  fields: QuestionField[];
  /** null while open. */
  resolved: { action: 'accept' | 'decline' | 'cancel'; answers?: QuestionAnswers } | null;
}

export interface NoticeItem {
  kind: 'notice';
  key: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  description?: string;
}

export interface ErrorItem {
  kind: 'error';
  key: string;
  message: string;
}

export type TranscriptItem = UserItem | MessageItem | ToolItem | ApprovalItem | QuestionItem | NoticeItem | ErrorItem;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  contextPercent?: number;
}

export interface Turn {
  key: string;
  items: TranscriptItem[];
  plan: PlanEntry[] | null;
  diff: FileDiff[] | null;
  usage: Usage | null;
  done: boolean;
  stopReason: string | null;
  /** Event time (ms) the turn started — drives the "Denkt nach…" timer before the first output. */
  startedAt?: number;
}

export interface SessionInfo {
  externalId: string | null;
  models: { id: string; name: string }[];
  currentModel: string | null;
  modes: { id: string; name: string; description?: string }[];
  currentMode: string | null;
  commands: { name: string; description?: string }[];
}

export interface TranscriptState {
  /** Highest contiguously applied seq (-1 = nothing yet). */
  lastSeq: number;
  /** Out-of-order records waiting for a gap to be filled, keyed by seq. */
  pending: Map<number, SessionEventRecord>;
  /** True while `pending` is non-empty (caller should fetch events since lastSeq). */
  gap: boolean;
  /** True after the first settled load. */
  loaded: boolean;
  turns: Turn[];
  /** itemKey → [turnIndex, itemIndex] */
  index: Map<string, [number, number]>;
  info: SessionInfo | null;
  usage: Usage | null;
  status: SessionStatus | null;
  statusMessage: string | null;
  /** Number of applied events (diagnostics). */
  applied: number;
}

export function emptyTranscript(): TranscriptState {
  return {
    lastSeq: -1,
    pending: new Map(),
    gap: false,
    loaded: false,
    turns: [],
    index: new Map(),
    info: null,
    usage: null,
    status: null,
    statusMessage: null,
    applied: 0,
  };
}

// ---- batch draft ------------------------------------------------------------------

class Draft {
  s: TranscriptState;
  private turnsCopied = false;
  private indexCopied = false;
  private copiedTurns = new Set<number>();
  private copiedItems = new Set<string>();
  private turnSeq: number;

  constructor(prev: TranscriptState) {
    this.s = { ...prev };
    this.turnSeq = prev.turns.length;
  }

  private turnsW(): Turn[] {
    if (!this.turnsCopied) {
      this.s.turns = this.s.turns.slice();
      this.turnsCopied = true;
    }
    return this.s.turns;
  }

  private indexW(): Map<string, [number, number]> {
    if (!this.indexCopied) {
      this.s.index = new Map(this.s.index);
      this.indexCopied = true;
    }
    return this.s.index;
  }

  /** Writable copy of turn i (items array copied too). */
  turn(i: number): Turn {
    const turns = this.turnsW();
    if (!this.copiedTurns.has(i)) {
      const t = turns[i]!;
      turns[i] = { ...t, items: t.items.slice() };
      this.copiedTurns.add(i);
    }
    return turns[i]!;
  }

  newTurn(): number {
    const turns = this.turnsW();
    const key = `t${this.turnSeq++}`;
    turns.push({ key, items: [], plan: null, diff: null, usage: null, done: false, stopReason: null });
    const i = turns.length - 1;
    this.copiedTurns.add(i);
    return i;
  }

  /** Index of the current (last) turn, creating one when none exists. */
  current(): number {
    if (this.s.turns.length === 0) return this.newTurn();
    return this.s.turns.length - 1;
  }

  find(key: string): [number, number] | undefined {
    return this.s.index.get(key);
  }

  add(item: TranscriptItem, turnIdx = this.current()) {
    const t = this.turn(turnIdx);
    t.items.push(item);
    this.indexW().set(item.key, [turnIdx, t.items.length - 1]);
    this.copiedItems.add(item.key);
  }

  /** Writable copy of an existing item. */
  item<T extends TranscriptItem>(pos: [number, number]): T {
    const t = this.turn(pos[0]);
    const it = t.items[pos[1]]!;
    if (!this.copiedItems.has(it.key)) {
      t.items[pos[1]] = { ...it };
      this.copiedItems.add(it.key);
    }
    return t.items[pos[1]] as T;
  }
}

function appendCapped(prev: string, chunk: string): { text: string; truncated: boolean } {
  const text = prev + chunk;
  if (text.length <= MAX_TOOL_OUTPUT) return { text, truncated: false };
  return { text: text.slice(text.length - MAX_TOOL_OUTPUT), truncated: true };
}

function applyEvent(d: Draft, ev: AgentEvent, ts?: number) {
  switch (ev.type) {
    case 'user.message': {
      const key = `user:${ev.id}`;
      if (d.find(key)) return;
      const cur = d.s.turns[d.s.turns.length - 1];
      // Reuse an empty turn (e.g. opened by turn.start before the echo arrived).
      const reuse = cur && !cur.done && cur.items.length === 0;
      const ti = reuse ? d.s.turns.length - 1 : d.newTurn();
      d.add({ kind: 'user', key, id: ev.id, text: ev.text, images: ev.images }, ti);
      if (ts !== undefined) d.turn(ti).startedAt ??= ts;
      return;
    }
    case 'turn.start': {
      const cur = d.s.turns[d.s.turns.length - 1];
      const ti = !cur || cur.done ? d.newTurn() : d.s.turns.length - 1;
      if (ts !== undefined) d.turn(ti).startedAt ??= ts;
      return;
    }
    case 'turn.done': {
      if (d.s.turns.length === 0) return;
      const t = d.turn(d.s.turns.length - 1);
      t.done = true;
      t.stopReason = ev.stopReason;
      // finalize streaming messages and dangling tools of this turn
      for (let i = 0; i < t.items.length; i++) {
        const it = t.items[i]!;
        if (it.kind === 'message' && !it.done) t.items[i] = { ...it, done: true, endedAt: it.endedAt ?? ts };
      }
      return;
    }
    case 'message.delta':
    case 'message.done': {
      // Keyed by role too: some agents (claude-agent-acp) use one messageId for both thinking and answer.
      const key = `msg:${ev.role}:${ev.id}`;
      const pos = d.find(key);
      if (!pos) {
        const done = ev.type === 'message.done';
        d.add({
          kind: 'message',
          key,
          id: ev.id,
          role: ev.role,
          text: ev.text,
          done,
          startedAt: ts,
          endedAt: done ? ts : undefined,
          durationMs: ev.type === 'message.done' ? ev.durationMs : undefined,
          ...(ev.parentId ? { parentId: ev.parentId } : {}),
        });
        return;
      }
      const m = d.item<MessageItem>(pos);
      m.startedAt ??= ts;
      if (ev.type === 'message.delta') {
        m.text += ev.text;
      } else {
        if (ev.text) m.text = ev.text;
        m.done = true;
        m.endedAt = ts;
        if (ev.durationMs !== undefined) m.durationMs = ev.durationMs;
      }
      return;
    }
    case 'tool.start': {
      const key = `tool:${ev.id}`;
      const pos = d.find(key);
      if (pos) {
        const t = d.item<ToolItem>(pos);
        t.toolKind = ev.kind;
        t.title = ev.title;
        if (ev.input !== undefined) t.input = ev.input;
        if (ev.locations) t.locations = ev.locations;
        if (ev.parentId) t.parentId = ev.parentId;
        return;
      }
      d.add({
        kind: 'tool',
        key,
        id: ev.id,
        toolKind: ev.kind,
        title: ev.title,
        status: 'running',
        input: ev.input,
        locations: ev.locations,
        output: '',
        outputTruncated: false,
        ...(ev.parentId ? { parentId: ev.parentId } : {}),
        startedAt: ts,
      });
      return;
    }
    case 'tool.update':
    case 'tool.done': {
      const key = `tool:${ev.id}`;
      let pos = d.find(key);
      if (!pos) {
        d.add({
          kind: 'tool',
          key,
          id: ev.id,
          toolKind: 'other',
          title: (ev.type === 'tool.update' && ev.title) || 'Werkzeug',
          status: 'running',
          output: '',
          outputTruncated: false,
        });
        pos = d.find(key)!;
      }
      const t = d.item<ToolItem>(pos);
      if (ev.type === 'tool.update') {
        if (ev.status) t.status = ev.status;
        if (ev.title) t.title = ev.title;
        if (ev.locations) t.locations = ev.locations;
        if (ev.diffs) t.diffs = ev.diffs;
        if (ev.output) {
          const r = appendCapped(t.output, ev.output);
          t.output = r.text;
          t.outputTruncated ||= r.truncated;
        }
      } else {
        t.status = ev.status;
        t.endedAt ??= ts;
        if (ev.diffs) t.diffs = ev.diffs;
        if (ev.output) {
          // done.output is either the full output (superset of streamed chunks) or a final chunk
          if (!t.output || t.outputTruncated || ev.output.startsWith(t.output)) {
            const r = appendCapped('', ev.output);
            t.output = r.text;
            t.outputTruncated ||= r.truncated;
          } else if (!t.output.endsWith(ev.output)) {
            const r = appendCapped(t.output, ev.output);
            t.output = r.text;
            t.outputTruncated ||= r.truncated;
          }
        }
      }
      return;
    }
    case 'approval.request': {
      const key = `approval:${ev.id}`;
      if (d.find(key)) return;
      d.add({
        kind: 'approval',
        key,
        id: ev.id,
        toolId: ev.toolId,
        approvalKind: ev.kind,
        title: ev.title,
        detail: ev.detail,
        diffs: ev.diffs,
        options: ev.options,
        resolvedOptionId: null,
      });
      return;
    }
    case 'approval.resolved': {
      const pos = d.find(`approval:${ev.id}`);
      if (!pos) return;
      d.item<ApprovalItem>(pos).resolvedOptionId = ev.optionId;
      return;
    }
    case 'notice': {
      const ti = d.current();
      const n = d.s.turns[ti]?.items.length ?? 0;
      d.add({ kind: 'notice', key: `notice:${ti}:${n}`, severity: ev.severity, title: ev.title, description: ev.description }, ti);
      return;
    }
    case 'question.request': {
      const key = `question:${ev.id}`;
      if (d.find(key)) return;
      d.add({ kind: 'question', key, id: ev.id, toolId: ev.toolId, message: ev.message, fields: ev.fields, resolved: null });
      return;
    }
    case 'question.resolved': {
      const pos = d.find(`question:${ev.id}`);
      if (!pos) return;
      d.item<QuestionItem>(pos).resolved = { action: ev.action, ...(ev.answers ? { answers: ev.answers } : {}) };
      return;
    }
    case 'plan': {
      d.turn(d.current()).plan = ev.entries;
      return;
    }
    case 'diff.turn': {
      d.turn(d.current()).diff = ev.files;
      return;
    }
    case 'usage': {
      const u: Usage = {};
      if (ev.inputTokens !== undefined) u.inputTokens = ev.inputTokens;
      if (ev.outputTokens !== undefined) u.outputTokens = ev.outputTokens;
      if (ev.costUsd !== undefined) u.costUsd = ev.costUsd;
      if (ev.contextPercent !== undefined) u.contextPercent = ev.contextPercent;
      d.s.usage = { ...d.s.usage, ...u };
      if (d.s.turns.length > 0) {
        const t = d.turn(d.s.turns.length - 1);
        t.usage = { ...t.usage, ...u };
      }
      return;
    }
    case 'status': {
      d.s.status = ev.status;
      d.s.statusMessage = ev.message ?? null;
      return;
    }
    case 'error': {
      d.add({ kind: 'error', key: `error:${d.s.applied}`, message: ev.message });
      return;
    }
    case 'session.info': {
      const prev = d.s.info;
      d.s.info = {
        externalId: ev.externalId ?? prev?.externalId ?? null,
        models: ev.models ?? prev?.models ?? [],
        currentModel: ev.currentModel !== undefined ? ev.currentModel : (prev?.currentModel ?? null),
        modes: ev.modes ?? prev?.modes ?? [],
        currentMode: ev.currentMode !== undefined ? ev.currentMode : (prev?.currentMode ?? null),
        commands: ev.commands ?? prev?.commands ?? [],
      };
      return;
    }
  }
}

export interface IngestOptions {
  /** Drain the pending buffer even when there are holes (after a fetch returned). */
  settle?: boolean;
}

/** Apply a batch of records (any order, duplicates allowed). Returns the same object when nothing changed. */
export function ingest(prev: TranscriptState, records: SessionEventRecord[], opts: IngestOptions = {}): TranscriptState {
  let pending = prev.pending;
  let pendingCopied = false;
  for (const r of records) {
    if (r.seq <= prev.lastSeq || pending.has(r.seq)) continue;
    if (!pendingCopied) {
      pending = new Map(pending);
      pendingCopied = true;
    }
    pending.set(r.seq, r);
  }
  const mustSettle = !!opts.settle && (!prev.loaded || pending.size > 0);
  if (!pendingCopied && !mustSettle) return prev;

  const d = new Draft(prev);
  d.s.pending = pending;
  const seqs = [...pending.keys()].sort((a, b) => a - b);
  for (const seq of seqs) {
    // The very first record defines the start (seq numbering may begin at 0 or 1).
    const contiguous = seq === d.s.lastSeq + 1 || (d.s.lastSeq === -1 && (!!opts.settle || prev.loaded));
    if (!contiguous && !opts.settle) break;
    const r = pending.get(seq)!;
    if (!pendingCopied) {
      d.s.pending = new Map(d.s.pending);
      pendingCopied = true;
    }
    d.s.pending.delete(seq);
    const ts = Date.parse(r.ts);
    applyEvent(d, r.event, Number.isFinite(ts) ? ts : undefined);
    d.s.applied++;
    d.s.lastSeq = seq;
  }
  d.s.gap = d.s.pending.size > 0;
  if (opts.settle) d.s.loaded = true;
  return d.s;
}

// ---- derived helpers --------------------------------------------------------------

export function pendingApprovals(s: TranscriptState): ApprovalItem[] {
  const out: ApprovalItem[] = [];
  const last = s.turns[s.turns.length - 1];
  if (!last) return out;
  for (const it of last.items) if (it.kind === 'approval' && !it.resolvedOptionId) out.push(it);
  return out;
}
