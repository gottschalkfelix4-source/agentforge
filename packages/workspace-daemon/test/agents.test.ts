import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent, WsdNotifications } from '@vibe/shared';
import { AgentHost } from '../src/agents/host.js';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent-adapters/test/fixtures/fake-acp-agent.mjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-agents-')));
fs.mkdirSync(path.join(root, 'sub'));

type Note = { method: keyof WsdNotifications; params: WsdNotifications[keyof WsdNotifications] };
const notes: Note[] = [];
const host = new AgentHost(root, (method, params) => notes.push({ method, params }));

afterAll(async () => {
  await host.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const eventsOf = (sessionId: string) =>
  notes
    .filter((n) => n.method === 'agent.event' && (n.params as WsdNotifications['agent.event']).sessionId === sessionId)
    .map((n) => n.params as WsdNotifications['agent.event']);

async function waitFor(sessionId: string, pred: (e: AgentEvent) => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = eventsOf(sessionId).find((n) => pred(n.event));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout; got ${eventsOf(sessionId).map((n) => n.event.type + (n.event.type === 'status' ? `:${n.event.status}` : '')).join(',')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const params = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  agentId: 'fake',
  transport: 'acp' as const,
  command: process.execPath,
  args: [fixture],
  cwd: 'sub',
  env: { VIBE_TEST: '1' },
  mcpServers: [],
  ...extra,
});

describe('AgentHost', () => {
  it('runs a session: statuses, approval, seq and backfill', async () => {
    const res = await host.start(params('s1'));
    expect(res.externalId).toMatch(/^fake-/);
    await host.prompt({ sessionId: 's1', text: 'hallo' });
    const req = await waitFor('s1', (e) => e.type === 'approval.request');
    await waitFor('s1', (e) => e.type === 'status' && e.status === 'awaiting_approval');
    host.respond({ sessionId: 's1', requestId: (req.event as { id: string }).id, optionId: 'allow' });
    await waitFor('s1', (e) => e.type === 'turn.done');
    await waitFor('s1', (e) => e.type === 'status' && e.status === 'idle' && eventsOf('s1').some((x) => x.event.type === 'turn.done'));

    const evs = eventsOf('s1');
    // contiguous seq starting at 1
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    const types = evs.map((e) => (e.event.type === 'status' ? `status:${e.event.status}` : e.event.type));
    expect(types[0]).toBe('status:starting');
    expect(types).toContain('session.info');
    const iUser = types.indexOf('user.message');
    expect(types.slice(iUser, iUser + 3)).toEqual(['user.message', 'turn.start', 'status:running']);
    expect(types.indexOf('status:idle')).toBeLessThan(iUser);
    const iResolved = types.indexOf('approval.resolved');
    expect(types[iResolved + 1]).toBe('status:running');
    expect(types.at(-1)).toBe('status:idle');
    // deltas of the same message are coalesced
    const deltas = evs.filter((e) => e.event.type === 'message.delta' && e.event.role === 'assistant');
    expect(deltas.map((d) => (d.event as { text: string }).text)).toContain('Hallo Welt');
    // env reached the agent's cwd (fs write through the client lands in sub/)
    expect(fs.existsSync(path.join(root, 'sub', 'fake-out.txt'))).toBe(true);

    expect(host.events({ sessionId: 's1', since: evs.length - 2 }).map((r) => r.seq)).toEqual([evs.length - 1, evs.length]);
    expect(host.list()).toContainEqual({ sessionId: 's1', running: true, lastSeq: evs.length, externalId: res.externalId });
  });

  it('queues prompts while a turn runs', async () => {
    await host.start(params('s2'));
    host.prompt({ sessionId: 's2', text: 'slow' });
    host.prompt({ sessionId: 's2', text: 'slow' });
    await waitFor('s2', (e) => e.type === 'message.delta');
    expect(eventsOf('s2').filter((e) => e.event.type === 'user.message')).toHaveLength(1);
    await host.cancel({ sessionId: 's2' }); // also drops the queue
    await waitFor('s2', (e) => e.type === 'turn.done');
    await new Promise((r) => setTimeout(r, 100));
    expect(eventsOf('s2').filter((e) => e.event.type === 'user.message')).toHaveLength(1);
  });

  it('stop → stopped + agent.exit; restart continues seq after startSeq', async () => {
    await host.start(params('s3'));
    await host.stop({ sessionId: 's3' });
    await waitFor('s3', (e) => e.type === 'status' && e.status === 'stopped');
    expect(notes.some((n) => n.method === 'agent.exit' && (n.params as { sessionId: string }).sessionId === 's3')).toBe(true);
    expect(() => host.prompt({ sessionId: 's3', text: 'x' })).toThrow(/läuft nicht/);
    const last = eventsOf('s3').at(-1)!.seq;
    await host.start(params('s3', { startSeq: 100, resumeExternalId: 'persisted-1' }));
    const after = eventsOf('s3').filter((e) => e.seq > last);
    expect(after[0]!.seq).toBe(101);
    expect(host.list().find((s) => s.sessionId === 's3')!.externalId).toBe('persisted-1');
    await expect(host.start(params('s3'))).rejects.toThrow(/läuft bereits/);
  });

  it('crash → error status and agent.exit with message', async () => {
    await host.start(params('s4'));
    host.prompt({ sessionId: 's4', text: 'crash' });
    await waitFor('s4', (e) => e.type === 'status' && e.status === 'error');
    const types = eventsOf('s4').map((e) => e.event.type);
    expect(types).toContain('turn.done');
    const exit = notes.find((n) => n.method === 'agent.exit' && (n.params as { sessionId: string }).sessionId === 's4');
    expect((exit!.params as { code: number }).code).toBe(3);
  });

  it('failed start → EAGENT error and error status', async () => {
    await expect(host.start(params('s5', { command: 'no-such-agent-binary-xyz' }))).rejects.toThrow(/nicht gestartet/);
    await waitFor('s5', (e) => e.type === 'status' && e.status === 'error');
    expect(host.list().find((s) => s.sessionId === 's5')!.running).toBe(false);
    await expect(host.start(params('s6', { cwd: '../outside' }))).rejects.toThrow();
  });
});
