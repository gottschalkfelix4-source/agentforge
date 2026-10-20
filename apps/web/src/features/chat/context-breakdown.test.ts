import { describe, expect, it } from 'vitest';
import type { AgentEvent, SessionEventRecord } from '@vibe/shared';
import { contextBreakdown } from './context-breakdown';
import { emptyTranscript, ingest } from './transcript';

const seqd = (events: AgentEvent[]): SessionEventRecord[] =>
  events.map((event, i) => ({ seq: i + 1, ts: new Date(0).toISOString(), event }));

describe('usage reducer and context breakdown', () => {
  const s = ingest(
    emptyTranscript(),
    seqd([
      { type: 'user.message', id: 'u1', text: 'x'.repeat(400) },
      { type: 'turn.start' },
      { type: 'message.done', id: 'm1', role: 'assistant', text: 'y'.repeat(800) },
      { type: 'tool.start', id: 't1', kind: 'exec', title: 'ls', input: { command: 'ls' } },
      { type: 'tool.done', id: 't1', status: 'completed', output: 'z'.repeat(1200) },
      { type: 'tool.start', id: 't2', kind: 'read', title: 'sub', input: 'a'.repeat(4000), parentId: 't1' },
      { type: 'usage', spent: { input: 100, cachedInput: 50, cacheWrite: 0, output: 20 }, spentUsd: 0.01, costUsd: 0.01, costEstimated: true },
      { type: 'usage', spent: { input: 10, cachedInput: 0, cacheWrite: 5, output: 2 }, spentUsd: 0.002, costUsd: 0.012, costEstimated: true },
      { type: 'usage', contextUsed: 5000, contextWindow: 100_000, contextPercent: 5 },
      { type: 'turn.done', stopReason: 'end_turn' },
    ]),
    { settle: true },
  );

  it('sums billed tokens and the turn cost', () => {
    expect(s.usage).toMatchObject({ costUsd: 0.012, costEstimated: true, spent: { input: 110, cachedInput: 50, cacheWrite: 5, output: 22 } });
    expect(s.turns[0]!.usage?.turnCostUsd).toBeCloseTo(0.012);
    expect(s.turns[0]!.usage?.spent).toEqual({ input: 110, cachedInput: 50, cacheWrite: 5, output: 22 });
  });

  it('estimates the context split, leaving sub-agent steps out', () => {
    const b = contextBreakdown(s.turns, 5000);
    expect(b.compacted).toBe(false);
    const by = Object.fromEntries(b.parts.map((p) => [p.key, p.tokens]));
    expect(by.user).toBe(100);
    expect(by.assistant).toBe(200);
    expect(by.tools).toBe(Math.ceil((2 + JSON.stringify({ command: 'ls' }).length + 1200) / 4));
    expect(by.rest).toBe(5000 - by.user! - by.assistant! - by.tools!);
  });

  it('scales the parts down when the history no longer fits (compaction)', () => {
    const b = contextBreakdown(s.turns, 300);
    expect(b.compacted).toBe(true);
    expect(b.parts.reduce((a, p) => a + p.tokens, 0)).toBe(300);
  });
});
