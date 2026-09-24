import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, Channel, ServerEvent } from '@vibe/shared';
import { Db, nowIso } from '../db/index.js';
import { bus } from '../events.js';
import { buildStructuredLaunch } from '../agents/launch.js';
import { autoApproval, openApprovals } from './approval-policy.js';
import { autoTitle, DEFAULT_TITLE, SessionStore, toSession } from './service.js';

const db = new Db(':memory:');
const store = new SessionStore(db);
const published: { ch: Channel; e: ServerEvent }[] = [];
const unsub = bus.subscribe((ch, e) => published.push({ ch, e }));

afterAll(() => {
  unsub();
  db.close();
});

db.insert('projects', { id: 'p1', name: 'P', slug: 'p', git_url: null, default_branch: null, created_at: nowIso(), archived: 0 });

let n = 0;
function newSession(title = DEFAULT_TITLE) {
  const id = `s${++n}`;
  const now = nowIso();
  db.insert('agent_sessions', {
    id,
    project_id: 'p1',
    agent_id: 'codex',
    profile_id: null,
    transport: 'codex_app_server',
    title,
    status: 'starting',
    status_message: null,
    external_id: null,
    cwd: '.',
    task_run_id: null,
    current_model: null,
    current_mode: null,
    last_seq: 0,
    created_at: now,
    updated_at: now,
  });
  return id;
}

const rec = (seq: number, event: AgentEvent) => ({ seq, ts: new Date(1_700_000_000_000 + seq).toISOString(), event });

beforeEach(() => {
  published.length = 0;
});

describe('SessionStore.ingest', () => {
  it('is idempotent on (session_id, seq) and tracks last_seq', () => {
    const id = newSession();
    expect(store.ingest('p1', id, rec(1, { type: 'turn.start' }))).toBe(true);
    expect(store.ingest('p1', id, rec(1, { type: 'turn.start' }))).toBe(false);
    expect(store.ingest('p1', id, rec(3, { type: 'error', message: 'x' }))).toBe(true);
    // late (backfilled) event below last_seq is still stored, last_seq does not go down
    expect(store.ingest('p1', id, rec(2, { type: 'turn.done', stopReason: 'end_turn' }))).toBe(true);
    expect(store.require(id).last_seq).toBe(3);
    expect(store.events(id, 0).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(store.events(id, 2).map((r) => r.event.type)).toEqual(['error']);
    // duplicates are not re-published
    expect(published.filter((p) => p.ch === `session:${id}`)).toHaveLength(3);
  });

  it('ignores unknown sessions and sessions of other projects', () => {
    const id = newSession();
    expect(store.ingest('p1', 'nope', rec(1, { type: 'turn.start' }))).toBe(false);
    expect(store.ingest('other', id, rec(1, { type: 'turn.start' }))).toBe(false);
    expect(store.events(id, 0)).toEqual([]);
  });

  it('updates status, external id, model/mode and auto-titles from the first user message', () => {
    const id = newSession();
    store.ingest('p1', id, rec(1, { type: 'status', status: 'idle' }));
    store.ingest('p1', id, rec(2, { type: 'session.info', externalId: 'thr_1', currentModel: 'gpt-5', currentMode: 'ask' }));
    store.ingest('p1', id, rec(3, { type: 'user.message', id: 'u1', text: '  Bitte   baue mir eine\nTodo-App mit React, Tailwind und einem kleinen Express-Backend dazu  ' }));
    store.ingest('p1', id, rec(4, { type: 'user.message', id: 'u2', text: 'zweite Nachricht' }));
    store.ingest('p1', id, rec(5, { type: 'status', status: 'error', message: 'kaputt' }));
    const row = store.require(id);
    expect(row).toMatchObject({ status: 'error', status_message: 'kaputt', external_id: 'thr_1', current_model: 'gpt-5', current_mode: 'ask', last_seq: 5 });
    expect(row.title).toBe(autoTitle('Bitte baue mir eine Todo-App mit React, Tailwind und einem kleinen Express-Backend dazu'));
    expect(row.title.length).toBeLessThanOrEqual(60);
    expect(row.title.endsWith('…')).toBe(true);
    const updates = published.filter((p) => p.e.type === 'session.updated');
    expect(updates.length).toBe(4); // status, info, title, status
    expect(published.filter((p) => p.ch === 'project:p1' && p.e.type === 'session.updated').length).toBe(4);
  });

  it('keeps a user-given title', () => {
    const id = newSession('Mein Titel');
    store.ingest('p1', id, rec(1, { type: 'user.message', id: 'u1', text: 'hallo' }));
    expect(store.require(id).title).toBe('Mein Titel');
  });

  it('prunes streamed deltas once the message / tool output is complete', () => {
    const id = newSession();
    store.ingest('p1', id, rec(1, { type: 'message.delta', id: 'm1', role: 'assistant', text: 'Hal' }));
    store.ingest('p1', id, rec(2, { type: 'message.delta', id: 'm2', role: 'thought', text: 'hm' }));
    store.ingest('p1', id, rec(3, { type: 'message.delta', id: 'm1', role: 'assistant', text: 'lo' }));
    store.ingest('p1', id, rec(4, { type: 'message.done', id: 'm1', role: 'assistant', text: 'Hallo' }));
    store.ingest('p1', id, rec(5, { type: 'tool.start', id: 't1', kind: 'exec', title: 'ls' }));
    store.ingest('p1', id, rec(6, { type: 'tool.update', id: 't1', output: 'a\n' }));
    store.ingest('p1', id, rec(7, { type: 'tool.update', id: 't1', status: 'running' }));
    store.ingest('p1', id, rec(8, { type: 'tool.done', id: 't1', status: 'completed', output: 'a\n' }));
    expect(store.events(id, 0).map((r) => r.seq)).toEqual([2, 4, 5, 7, 8]);
    // the pruned seqs are not re-inserted by a later backfill (last_seq stays)
    expect(store.require(id).last_seq).toBe(8);
  });

  it('markStopped only touches live sessions', () => {
    const a = newSession();
    store.ingest('p1', a, rec(1, { type: 'status', status: 'running' }));
    store.markStopped(a, 'weg');
    expect(store.require(a)).toMatchObject({ status: 'stopped', status_message: 'weg' });
    const b = newSession();
    store.ingest('p1', b, rec(1, { type: 'status', status: 'error', message: 'kaputt' }));
    store.markStopped(b, 'weg');
    expect(store.require(b)).toMatchObject({ status: 'error', status_message: 'kaputt' });
  });

  it('lists newest activity first', () => {
    const list = store.list('p1');
    expect(list.length).toBeGreaterThan(1);
    const times = list.map((s) => s.updatedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe('autoTitle', () => {
  it('collapses whitespace and falls back to the default', () => {
    expect(autoTitle('  a\n\tb ')).toBe('a b');
    expect(autoTitle('   ')).toBe(DEFAULT_TITLE);
  });
});

describe('buildStructuredLaunch', () => {
  const base = { id: 'p', agentKind: 'codex', name: 'P', authMode: 'provider' as const, providerId: 'x', model: 'm1', extraArgs: ['--tui-flag'], env: { FOO: '1' }, createdAt: '' };
  const prov = { id: 'x', kind: 'openrouter' as const, name: 'OR', baseUrl: null, hasKey: true, secretId: 's', models: [], defaultModel: 'dm', createdAt: '' };

  it('codex: app-server + provider overrides, no TUI extraArgs', () => {
    const l = buildStructuredLaunch('codex', { profile: base, provider: prov, apiKey: 'k' });
    expect(l.transport).toBe('codex_app_server');
    expect(l.command).toBe('codex');
    expect(l.args.slice(0, 3)).toEqual(['app-server', '-c', 'model_provider="vibe"']);
    expect(l.args).not.toContain('--tui-flag');
    expect(l.env).toMatchObject({ CODEX_HOME: '/home/coder/.codex', VIBE_PROVIDER_KEY: 'k', FOO: '1' });
    expect(l.model).toBe('m1');
  });

  it('claude: ACP adapter with provider env, subscription without env', () => {
    const l = buildStructuredLaunch('claude', { profile: { ...base, agentKind: 'claude', model: null }, provider: { ...prov, kind: 'anthropic' }, apiKey: 'sk' });
    expect(l).toMatchObject({ transport: 'acp', command: 'claude-agent-acp', args: [], model: 'dm' });
    expect(l.env.ANTHROPIC_API_KEY).toBe('sk');
    const sub = buildStructuredLaunch('claude', { profile: null, provider: null, apiKey: null });
    expect(sub.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/coder/.claude' });
    expect(sub.model).toBeNull();
  });
});

describe('approval policy', () => {
  type Req = Extract<AgentEvent, { type: 'approval.request' }>;
  const req = (id: string, kind: Req['kind'], options: Req['options']): Req => ({ type: 'approval.request', id, kind, title: 't', options });
  const claudeOptions: Req['options'] = [
    { id: 'always', label: 'Always allow', kind: 'allow_always' },
    { id: 'once', label: 'Allow', kind: 'allow_once' },
    { id: 'no', label: 'Reject', kind: 'reject_once' },
  ];

  it('ask never answers; edits only file changes; all everything — one-time permission first', () => {
    expect(autoApproval(req('a', 'edit', claudeOptions), 'ask')).toBeNull();
    expect(autoApproval(req('a', 'edit', claudeOptions), 'edits')).toBe('once');
    expect(autoApproval(req('a', 'exec', claudeOptions), 'edits')).toBeNull();
    expect(autoApproval(req('a', 'exec', claudeOptions), 'all')).toBe('once');
    expect(autoApproval(req('a', 'other', [{ id: 'x', label: 'Always', kind: 'allow_always' }]), 'all')).toBe('x');
    expect(autoApproval(req('a', 'other', [{ id: 'no', label: 'Reject', kind: 'reject_once' }]), 'all')).toBeNull();
  });

  it('openApprovals drops resolved requests', () => {
    const events: AgentEvent[] = [req('a', 'edit', claudeOptions), req('b', 'exec', claudeOptions), { type: 'approval.resolved', id: 'a', optionId: 'once' }];
    expect(openApprovals(events).map((e) => e.id)).toEqual(['b']);
  });

  it('sessions default to ask', () => {
    expect(toSession(store.require(newSession())).approvalPolicy).toBe('ask');
  });
});
