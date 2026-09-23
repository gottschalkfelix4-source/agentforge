import { describe, expect, it } from 'vitest';
import type { AgentEvent, SessionEventRecord } from '@vibe/shared';
import { emptyTranscript, ingest, MAX_TOOL_OUTPUT, pendingApprovals, type MessageItem, type ToolItem } from './transcript';

let seqCounter = 0;
const rec = (event: AgentEvent, seq = ++seqCounter): SessionEventRecord => ({ seq, ts: new Date(0).toISOString(), event });
const seqd = (events: AgentEvent[], start = 1) => events.map((e, i) => rec(e, start + i));

describe('transcript reducer', () => {
  it('merges deltas into one message and finalizes on done', () => {
    const s = ingest(
      emptyTranscript(),
      seqd([
        { type: 'user.message', id: 'u1', text: 'Hallo' },
        { type: 'turn.start' },
        { type: 'message.delta', id: 'm1', role: 'thought', text: 'hmm ' },
        { type: 'message.delta', id: 'm1', role: 'thought', text: 'ok' },
        { type: 'message.delta', id: 'm2', role: 'assistant', text: 'Hal' },
        { type: 'message.delta', id: 'm2', role: 'assistant', text: 'lo!' },
      ]),
      { settle: true },
    );
    expect(s.turns).toHaveLength(1);
    const items = s.turns[0]!.items;
    expect(items.map((i) => i.kind)).toEqual(['user', 'message', 'message']);
    expect((items[1] as MessageItem).text).toBe('hmm ok');
    expect((items[2] as MessageItem).text).toBe('Hallo!');
    expect((items[2] as MessageItem).done).toBe(false);

    const s2 = ingest(s, seqd([{ type: 'message.done', id: 'm2', role: 'assistant', text: 'Hallo Welt!' }], 7));
    expect((s2.turns[0]!.items[2] as MessageItem).text).toBe('Hallo Welt!');
    expect((s2.turns[0]!.items[2] as MessageItem).done).toBe(true);
    // untouched items keep identity (memoized rows)
    expect(s2.turns[0]!.items[0]).toBe(s.turns[0]!.items[0]);
    expect(s2.turns[0]!.items[1]).toBe(s.turns[0]!.items[1]);
  });

  it('tracks the tool lifecycle with appended output and diffs', () => {
    const s = ingest(
      emptyTranscript(),
      seqd([
        { type: 'user.message', id: 'u1', text: 'Test' },
        { type: 'tool.start', id: 't1', kind: 'exec', title: 'npm test' },
        { type: 'tool.update', id: 't1', output: 'line1\n' },
        { type: 'tool.update', id: 't1', output: 'line2\n', status: 'running' },
        { type: 'tool.done', id: 't1', status: 'completed', output: 'line1\nline2\nfertig\n' },
        { type: 'tool.start', id: 't2', kind: 'edit', title: 'Edit a.ts' },
        { type: 'tool.done', id: 't2', status: 'failed', diffs: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] },
      ]),
      { settle: true },
    );
    const [, t1, t2] = s.turns[0]!.items as [unknown, ToolItem, ToolItem];
    expect(t1.status).toBe('completed');
    expect(t1.output).toBe('line1\nline2\nfertig\n');
    expect(t2.status).toBe('failed');
    expect(t2.diffs?.[0]?.path).toBe('a.ts');
  });

  it('caps huge tool output', () => {
    const big = 'x'.repeat(MAX_TOOL_OUTPUT);
    const s = ingest(
      emptyTranscript(),
      seqd([
        { type: 'tool.start', id: 't1', kind: 'exec', title: 'cat' },
        { type: 'tool.update', id: 't1', output: big },
        { type: 'tool.update', id: 't1', output: 'END' },
      ]),
      { settle: true },
    );
    const t = s.turns[0]!.items[0] as ToolItem;
    expect(t.output.length).toBe(MAX_TOOL_OUTPUT);
    expect(t.output.endsWith('END')).toBe(true);
    expect(t.outputTruncated).toBe(true);
  });

  it('shows approvals until resolved', () => {
    const s = ingest(
      emptyTranscript(),
      seqd([
        { type: 'user.message', id: 'u1', text: 'rm' },
        {
          type: 'approval.request',
          id: 'a1',
          kind: 'exec',
          title: 'rm -rf dist',
          options: [
            { id: 'o1', label: 'Erlauben', kind: 'allow_once' },
            { id: 'o2', label: 'Ablehnen', kind: 'reject_once' },
          ],
        },
      ]),
      { settle: true },
    );
    expect(pendingApprovals(s)).toHaveLength(1);
    const s2 = ingest(s, seqd([{ type: 'approval.resolved', id: 'a1', optionId: 'o1' }], 3));
    expect(pendingApprovals(s2)).toHaveLength(0);
  });

  it('keeps the latest plan, usage and turn diff per turn', () => {
    const s = ingest(
      emptyTranscript(),
      seqd([
        { type: 'user.message', id: 'u1', text: 'a' },
        { type: 'plan', entries: [{ text: 'A', status: 'in_progress' }] },
        { type: 'plan', entries: [{ text: 'A', status: 'completed' }, { text: 'B', status: 'pending' }] },
        { type: 'usage', inputTokens: 10 },
        { type: 'usage', outputTokens: 5, contextPercent: 12 },
        { type: 'diff.turn', files: [{ path: 'x', oldText: null, newText: 'y' }] },
        { type: 'turn.done', stopReason: 'end_turn' },
        { type: 'user.message', id: 'u2', text: 'b' },
      ]),
      { settle: true },
    );
    expect(s.turns).toHaveLength(2);
    const t = s.turns[0]!;
    expect(t.plan?.map((e) => e.status)).toEqual(['completed', 'pending']);
    expect(t.usage).toEqual({ inputTokens: 10, outputTokens: 5, contextPercent: 12 });
    expect(t.diff).toHaveLength(1);
    expect(t.done).toBe(true);
    expect(s.turns[1]!.plan).toBeNull();
    expect(s.usage?.contextPercent).toBe(12);
  });

  it('dedupes by seq and buffers gaps until filled', () => {
    const base = ingest(emptyTranscript(), seqd([{ type: 'user.message', id: 'u1', text: 'a' }]), { settle: true });
    expect(base.lastSeq).toBe(1);

    // duplicate → no change (same object)
    expect(ingest(base, seqd([{ type: 'user.message', id: 'u1', text: 'a' }]))).toBe(base);

    // seq 4 arrives before 2/3 → buffered, gap flagged
    const withGap = ingest(base, [rec({ type: 'message.delta', id: 'm', role: 'assistant', text: 'C' }, 4)]);
    expect(withGap.gap).toBe(true);
    expect(withGap.lastSeq).toBe(1);
    expect(withGap.turns[0]!.items).toHaveLength(1);

    // gap fill (fetch since=1 returns 2..4, including the already buffered 4)
    const filled = ingest(
      withGap,
      [
        rec({ type: 'message.delta', id: 'm', role: 'assistant', text: 'A' }, 2),
        rec({ type: 'message.delta', id: 'm', role: 'assistant', text: 'B' }, 3),
        rec({ type: 'message.delta', id: 'm', role: 'assistant', text: 'C' }, 4),
      ],
      { settle: true },
    );
    expect(filled.gap).toBe(false);
    expect(filled.lastSeq).toBe(4);
    expect((filled.turns[0]!.items[1] as MessageItem).text).toBe('ABC');
  });

  it('settle drains buffered events even if the server has holes', () => {
    const base = ingest(emptyTranscript(), seqd([{ type: 'user.message', id: 'u1', text: 'a' }]), { settle: true });
    const withGap = ingest(base, [rec({ type: 'error', message: 'kaputt' }, 9)]);
    expect(withGap.gap).toBe(true);
    const settled = ingest(withGap, [], { settle: true });
    expect(settled.gap).toBe(false);
    expect(settled.lastSeq).toBe(9);
    expect(settled.turns[0]!.items[1]!.kind).toBe('error');
  });

  it('live events before the initial load are applied once it settles', () => {
    const early = ingest(emptyTranscript(), [rec({ type: 'message.delta', id: 'm', role: 'assistant', text: '!' }, 3)]);
    expect(early.turns).toHaveLength(0);
    const loaded = ingest(
      early,
      seqd([
        { type: 'user.message', id: 'u1', text: 'a' },
        { type: 'message.delta', id: 'm', role: 'assistant', text: 'Hi' },
      ]),
      { settle: true },
    );
    expect((loaded.turns[0]!.items[1] as MessageItem).text).toBe('Hi!');
  });

  it('merges session.info and tracks status', () => {
    const s = ingest(
      emptyTranscript(),
      seqd([
        {
          type: 'session.info',
          externalId: 'x',
          models: [{ id: 'a', name: 'A' }],
          currentModel: 'a',
          commands: [{ name: 'init' }],
        },
        { type: 'session.info', externalId: 'x', currentModel: 'b' },
        { type: 'status', status: 'running' },
      ]),
      { settle: true },
    );
    expect(s.info?.models).toHaveLength(1);
    expect(s.info?.currentModel).toBe('b');
    expect(s.info?.commands[0]?.name).toBe('init');
    expect(s.status).toBe('running');
  });

  it('handles thousands of events in one batch', () => {
    const events: AgentEvent[] = [{ type: 'user.message', id: 'u', text: 'go' }];
    for (let i = 0; i < 5000; i++) events.push({ type: 'message.delta', id: `m${i % 50}`, role: 'assistant', text: 'x' });
    const t0 = performance.now();
    const s = ingest(emptyTranscript(), seqd(events), { settle: true });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(s.turns[0]!.items).toHaveLength(51);
    expect((s.turns[0]!.items[1] as MessageItem).text.length).toBe(100);
  });
});

describe('thought timing', () => {
  const at = (event: AgentEvent, seq: number, ms: number): SessionEventRecord => ({ seq, ts: new Date(ms).toISOString(), event });

  it('records start/end timestamps of streamed thoughts', () => {
    const s = ingest(emptyTranscript(), [
      at({ type: 'user.message', id: 'u', text: 'Hi' }, 1, 1_000),
      at({ type: 'message.delta', id: 't', role: 'thought', text: 'Hmm ' }, 2, 2_000),
      at({ type: 'message.delta', id: 't', role: 'thought', text: 'ok' }, 3, 5_000),
      at({ type: 'message.done', id: 't', role: 'thought', text: 'Hmm ok' }, 4, 9_000),
    ], { settle: true });
    const m = s.turns[0]!.items.find((i) => i.kind === 'message') as MessageItem;
    expect(m).toMatchObject({ text: 'Hmm ok', done: true, startedAt: 2_000, endedAt: 9_000 });
  });

  it('keeps the adapter-reported duration when only message.done survived compaction', () => {
    const s = ingest(emptyTranscript(), [
      at({ type: 'user.message', id: 'u', text: 'Hi' }, 1, 1_000),
      at({ type: 'message.done', id: 't', role: 'thought', text: 'Plan', durationMs: 12_000 }, 5, 13_000),
    ], { settle: true });
    const m = s.turns[0]!.items.find((i) => i.kind === 'message') as MessageItem;
    expect(m.durationMs).toBe(12_000);
  });

  it('closes still-streaming thoughts at turn end with the turn.done time', () => {
    const s = ingest(emptyTranscript(), [
      at({ type: 'user.message', id: 'u', text: 'Hi' }, 1, 1_000),
      at({ type: 'message.delta', id: 't', role: 'thought', text: 'x' }, 2, 2_000),
      at({ type: 'turn.done', stopReason: 'end_turn' }, 3, 4_000),
    ], { settle: true });
    const m = s.turns[0]!.items.find((i) => i.kind === 'message') as MessageItem;
    expect(m).toMatchObject({ done: true, startedAt: 2_000, endedAt: 4_000 });
  });
});

describe('thought and answer sharing one message id (claude-agent-acp)', () => {
  it('keeps the answer as its own assistant message', () => {
    const at = (event: AgentEvent, seq: number): SessionEventRecord => ({ seq, ts: new Date(seq * 1000).toISOString(), event });
    const s = ingest(emptyTranscript(), [
      at({ type: 'user.message', id: 'u', text: 'test' }, 1),
      at({ type: 'message.delta', id: 'm1', role: 'thought', text: 'Der Nutzer testet.' }, 2),
      at({ type: 'message.done', id: 'm1', role: 'thought', text: 'Der Nutzer testet.' }, 3),
      at({ type: 'message.delta', id: 'm1', role: 'assistant', text: 'Got it — ' }, 4),
      at({ type: 'message.done', id: 'm1', role: 'assistant', text: 'Got it — test received.' }, 5),
    ], { settle: true });
    const msgs = s.turns[0]!.items.filter((i) => i.kind === 'message') as MessageItem[];
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['thought', 'Der Nutzer testet.'],
      ['assistant', 'Got it — test received.'],
    ]);
  });
});

describe('turn start time', () => {
  it('takes the time of the user message (drives the thinking timer)', () => {
    const s = ingest(emptyTranscript(), [
      { seq: 1, ts: new Date(7_000).toISOString(), event: { type: 'user.message', id: 'u', text: 'Hi' } },
      { seq: 2, ts: new Date(7_050).toISOString(), event: { type: 'turn.start' } },
    ], { settle: true });
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.startedAt).toBe(7_000);
  });
});

describe('agent questions', () => {
  it('adds a question item and records the answer', () => {
    const at = (event: AgentEvent, seq: number): SessionEventRecord => ({ seq, ts: new Date(seq * 1000).toISOString(), event });
    const s = ingest(emptyTranscript(), [
      at({ type: 'user.message', id: 'u', text: 'Plane die App' }, 1),
      at({
        type: 'question.request',
        id: 'q1',
        message: 'Welche Datenbank?',
        fields: [{ key: 'q0', kind: 'single', options: [{ value: 'SQLite', label: 'SQLite' }] }],
      }, 2),
    ], { settle: true });
    const open = s.turns[0]!.items.find((i) => i.kind === 'question');
    expect(open).toMatchObject({ id: 'q1', message: 'Welche Datenbank?', resolved: null });

    const s2 = ingest(s, [at({ type: 'question.resolved', id: 'q1', action: 'accept', answers: { q0: 'SQLite' } }, 3)]);
    const done = s2.turns[0]!.items.find((i) => i.kind === 'question');
    expect(done).toMatchObject({ resolved: { action: 'accept', answers: { q0: 'SQLite' } } });
  });
});

describe('runtime notices', () => {
  it('adds notice items apart from assistant messages', () => {
    const at = (event: AgentEvent, seq: number): SessionEventRecord => ({ seq, ts: new Date(seq * 1000).toISOString(), event });
    const s = ingest(emptyTranscript(), [
      at({ type: 'user.message', id: 'u', text: 'x' }, 1),
      at({ type: 'notice', severity: 'warning', title: 'Warning', description: 'a' }, 2),
      at({ type: 'notice', severity: 'warning', title: 'Warning', description: 'a' }, 3),
      at({ type: 'message.done', id: 'm', role: 'assistant', text: 'Antwort' }, 4),
    ], { settle: true });
    const kinds = s.turns[0]!.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'notice', 'notice', 'message']);
    expect(new Set(s.turns[0]!.items.map((i) => i.key)).size).toBe(4);
  });
});

describe('sub-agents', () => {
  it('keeps the parent of sub-agent steps and messages and times the sub-agent', () => {
    const at = (event: AgentEvent, seq: number): SessionEventRecord => ({ seq, ts: new Date(seq * 1000).toISOString(), event });
    const s = ingest(emptyTranscript(), [
      at({ type: 'user.message', id: 'u', text: 'x' }, 1),
      at({ type: 'tool.start', id: 'a1', kind: 'agent', title: 'Code durchsuchen', input: { prompt: 'Finde TODOs', subagent_type: 'Explore' } }, 2),
      at({ type: 'tool.start', id: 'g1', kind: 'search', title: 'grep', parentId: 'a1' }, 3),
      at({ type: 'message.delta', id: 'cm', role: 'assistant', text: 'Gefunden', parentId: 'a1' }, 4),
      at({ type: 'tool.done', id: 'a1', status: 'completed', output: 'Bericht' }, 6),
      at({ type: 'message.done', id: 'm', role: 'assistant', text: 'Fertig' }, 7),
    ], { settle: true });
    const items = s.turns[0]!.items;
    expect(items.find((i) => i.key === 'tool:a1')).toMatchObject({ toolKind: 'agent', status: 'completed', output: 'Bericht', startedAt: 2000, endedAt: 6000 });
    expect(items.find((i) => i.key === 'tool:g1')).toMatchObject({ parentId: 'a1' });
    expect(items.find((i) => i.key === 'msg:assistant:cm')).toMatchObject({ parentId: 'a1', text: 'Gefunden' });
    expect((items.find((i) => i.key === 'msg:assistant:m') as MessageItem).parentId).toBeUndefined();
  });
});
