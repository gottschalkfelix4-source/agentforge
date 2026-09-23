import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@vibe/shared';
import { codexMcpArgs, splitUnifiedDiff, startAgent, type AgentSessionHandle, type AgentStartOptions } from '../src/index.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapters-test-')));
const handles: AgentSessionHandle[] = [];

afterAll(async () => {
  await Promise.all(handles.map((h) => h.dispose()));
  fs.rmSync(cwd, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function start(transport: 'acp' | 'codex_app_server', extra: Partial<AgentStartOptions> = {}) {
  const script = transport === 'acp' ? 'fake-acp-agent.mjs' : 'fake-codex-app-server.mjs';
  const stderr: string[] = [];
  const h = startAgent(transport, {
    command: process.execPath,
    args: [path.join(fixtures, script)],
    cwd,
    env: env(),
    onStderr: (l) => stderr.push(l),
    ...extra,
  });
  handles.push(h);
  const events: AgentEvent[] = [];
  h.onEvent((e) => events.push(e));
  const waitFor = async <T extends AgentEvent['type']>(type: T, pred: (e: Extract<AgentEvent, { type: T }>) => boolean = () => true, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = events.find((e) => e.type === type && pred(e as Extract<AgentEvent, { type: T }>));
      if (found) return found as Extract<AgentEvent, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}; got ${events.map((e) => e.type).join(',')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { h, events, waitFor, stderr };
}

describe('AcpAdapter', () => {
  it('maps a full turn incl. approval round-trip, fs and plan', async () => {
    const { h, events, waitFor } = start('acp', { model: 'smart', mcpServers: [{ name: 'pw', command: 'x', args: [], env: { A: '1' } }] });
    await h.ready;
    expect(h.externalId).toMatch(/^fake-/);
    const info = await waitFor('session.info', (e) => !!e.commands);
    expect(info.models).toEqual([{ id: 'fast', name: 'Fast' }, { id: 'smart', name: 'Smart' }]);
    expect(info.currentModel).toBe('smart');
    expect(info.modes?.map((m) => m.id)).toEqual(['default', 'plan']);
    expect(info.commands).toEqual([{ name: 'review', description: 'Review code' }]);

    await h.prompt('mach was');
    const req = await waitFor('approval.request');
    expect(req).toMatchObject({ toolId: 'tc1', kind: 'exec', title: 'ls -la', detail: 'ls -la' });
    expect(req.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    // Messages before the tool call are closed with message.done.
    const thought = events.find((e) => e.type === 'message.done' && e.role === 'thought');
    expect(thought).toMatchObject({ text: 'Ich denke nach.' });
    expect((thought as { durationMs?: number }).durationMs).toBeGreaterThanOrEqual(0);
    const msg = events.find((e) => e.type === 'message.done' && e.role === 'assistant');
    expect(msg).toMatchObject({ text: 'Hallo Welt' });
    expect(events.find((e) => e.type === 'plan')).toEqual({
      type: 'plan',
      entries: [
        { text: 'Dateien auflisten', status: 'in_progress' },
        { text: 'Datei schreiben', status: 'pending' },
      ],
    });

    h.respondApproval(req.id, 'allow');
    const done = await waitFor('turn.done');
    expect(done.stopReason).toBe('end_turn');
    expect(events).toContainEqual({ type: 'approval.resolved', id: req.id, optionId: 'allow' });

    // tool output: appended suffixes, full text on done
    const outputs = events.filter((e) => e.type === 'tool.update' && e.id === 'tc1' && e.output).map((e) => (e as { output: string }).output);
    expect(outputs.join('')).toBe('a\nb\n');
    expect(events).toContainEqual({ type: 'tool.done', id: 'tc1', status: 'completed', output: 'a\nb\nc\n' });
    // tool_call created as completed with a diff → start + done with relative path
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.start', id: 'tc2', kind: 'edit', locations: ['fake-out.txt'] }));
    expect(events).toContainEqual({
      type: 'tool.done',
      id: 'tc2',
      status: 'completed',
      diffs: [{ path: 'fake-out.txt', oldText: null, newText: 'line1\nline2\nline3' }],
    });
    // fs/write_text_file + fs/read_text_file with line/limit
    expect(fs.readFileSync(path.join(cwd, 'fake-out.txt'), 'utf8')).toBe('line1\nline2\nline3');
    expect(events.filter((e) => e.type === 'message.done' && e.role === 'assistant').map((e) => (e as { text: string }).text)).toContain('Gelesen: line2');
    expect(events).toContainEqual({ type: 'usage', contextPercent: 50, costUsd: 0.01 });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 20 });
  });

  it('rejecting an approval fails the tool', async () => {
    const { h, events, waitFor } = start('acp');
    await h.ready;
    await h.prompt('x');
    const req = await waitFor('approval.request');
    h.respondApproval(req.id, 'reject');
    await waitFor('turn.done');
    expect(events).toContainEqual({ type: 'tool.done', id: 'tc1', status: 'failed' });
  });

  it('receives runtime notices separately from the answer', async () => {
    const { h, events, waitFor } = start('acp');
    await h.ready;
    await h.prompt('notice');
    await waitFor('turn.done');
    expect(events).toContainEqual({ type: 'notice', severity: 'warning', title: 'Warning', description: 'Auto mode classifier billing' });
    const answers = events.filter((e) => e.type === 'message.done' && e.role === 'assistant').map((e) => (e as { text: string }).text);
    expect(answers).toEqual(['Antwort']);
  });

  it('keeps sub-agent / side-query text out of the answer (Claude parentToolUseId)', async () => {
    const { h, events, waitFor } = start('acp');
    await h.ready;
    await h.prompt('subagent');
    await waitFor('turn.done');
    const answers = events.filter((e) => e.type === 'message.done' && e.role === 'assistant').map((e) => (e as { text: string }).text);
    expect(answers).toEqual(['Hier ist die Antwort.']);
    const side = events.filter((e) => e.type === 'tool.update' && e.id === 'ws1' && (e as { output?: string }).output);
    expect(side.map((e) => (e as { output: string }).output).join('')).toContain('I am Claude');
  });

  it('turns form elicitations (AskUserQuestion) into questions and answers them', async () => {
    const { h, events, waitFor } = start('acp');
    await h.ready;
    await h.prompt('ask');
    const q = await waitFor('question.request');
    expect(q).toMatchObject({ toolId: 'ask1', message: 'Welche Datenbank?' });
    expect(q.fields).toEqual([
      {
        key: 'q0',
        kind: 'single',
        title: 'DB',
        options: [
          { value: 'SQLite', label: 'SQLite', description: 'Eingebettet' },
          { value: 'Postgres', label: 'Postgres', preview: 'CREATE TABLE …' },
        ],
      },
      { key: 'q0_custom', kind: 'text', title: 'Other', customFor: 'q0' },
    ]);
    h.respondQuestion!(q.id, 'accept', { q0: 'Postgres', q0_custom: '  mit Docker  ', ignored: 'x' });
    await waitFor('turn.done');
    const answer = events.find((e) => e.type === 'message.done' && e.role === 'assistant') as { text: string };
    expect(JSON.parse(answer.text.replace('Antwort: ', ''))).toEqual({ action: 'accept', content: { q0: 'Postgres', q0_custom: 'mit Docker' } });
    expect(events).toContainEqual({ type: 'question.resolved', id: q.id, action: 'accept', answers: { q0: 'Postgres', q0_custom: 'mit Docker' } });
  });

  it('cancel also cancels open questions', async () => {
    const { h, events, waitFor } = start('acp');
    await h.ready;
    await h.prompt('ask');
    const q = await waitFor('question.request');
    await h.cancel();
    await waitFor('turn.done');
    expect(events).toContainEqual({ type: 'question.resolved', id: q.id, action: 'cancel' });
  });

  it('cancel resolves pending approvals and ends the turn', async () => {
    const { h, events, waitFor } = start('acp');
    await h.ready;
    await h.prompt('x');
    const req = await waitFor('approval.request');
    await h.cancel();
    const done = await waitFor('turn.done');
    expect(done.stopReason).toBe('cancelled');
    expect(events).toContainEqual({ type: 'approval.resolved', id: req.id, optionId: 'cancelled' });
    expect(() => h.respondApproval(req.id, 'allow')).toThrow();

    await h.prompt('slow');
    await waitFor('message.delta', (e) => e.text === '.');
    await h.cancel();
    expect((await waitFor('turn.done', (e) => e.stopReason === 'cancelled' && events.filter((x) => x.type === 'turn.done').length === 2)).stopReason).toBe('cancelled');
  });

  it('setMode / setModel update session.info', async () => {
    const { h, events, waitFor } = start('acp');
    await h.ready;
    await h.setMode!('plan');
    await waitFor('session.info', (e) => e.currentMode === 'plan');
    await h.setModel!('smart');
    await waitFor('session.info', (e) => e.currentModel === 'smart');
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('resumes via session/load and suppresses the history replay', async () => {
    const { h, events } = start('acp', { resumeExternalId: 'persisted-1' });
    await h.ready;
    expect(h.externalId).toBe('persisted-1');
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === 'message.delta')).toEqual([]);
  });

  it('falls back to a new session when load fails', async () => {
    const { h, events } = start('acp', { resumeExternalId: 'unknown' });
    await h.ready;
    expect(h.externalId).toMatch(/^fake-/);
    expect(events.some((e) => e.type === 'error' && /Fortsetzen fehlgeschlagen/.test(e.message))).toBe(true);
  });

  it('reports process exit mid-turn', async () => {
    const { h, waitFor } = start('acp');
    await h.ready;
    const exit = new Promise<{ code: number | null; message?: string }>((resolve) => h.onExit((code, message) => resolve({ code, message })));
    await h.prompt('crash');
    expect((await waitFor('turn.done')).stopReason).toBe('exited');
    const ex = await exit;
    expect(ex.code).toBe(3);
    expect(ex.message).toMatch(/Code 3/);
  });

  it('rejects ready when the binary does not exist', async () => {
    const h = startAgent('acp', { command: 'definitely-not-an-agent-binary', args: [], cwd, env: env() });
    await expect(h.ready).rejects.toThrow(/nicht gestartet/);
  });
});

describe('CodexAppServerAdapter', () => {
  it('maps a full turn incl. command approval', async () => {
    const { h, events, waitFor, stderr } = start('codex_app_server', {
      mcpServers: [{ name: 'playwright', command: 'playwright-mcp', args: ['--headless'], env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' } }],
    });
    await h.ready;
    expect(h.externalId).toBe('thr_new');
    const info = await waitFor('session.info', (e) => !!e.models);
    expect(info).toMatchObject({ currentMode: 'ask', currentModel: 'gpt-fake', models: [{ id: 'gpt-fake', name: 'GPT Fake' }] });
    expect(stderr.find((l) => l.startsWith('argv'))).toContain('mcp_servers.playwright.command=\\"playwright-mcp\\"');
    expect(stderr).toContain('notification initialized');

    await h.prompt('los');
    const req = await waitFor('approval.request');
    expect(req).toMatchObject({ toolId: 'cmd_1', kind: 'exec', title: 'Befehl ausführen: npm test' });
    const codexThought = events.find((e) => e.type === 'message.done' && e.role === 'thought');
    expect(codexThought).toMatchObject({ id: 'rs_1', text: 'Plane Schritte' });
    expect((codexThought as { durationMs?: number }).durationMs).toBeGreaterThanOrEqual(0);
    // raw reasoning deltas are ignored once summary deltas streamed
    expect(events.filter((e) => e.type === 'message.delta' && e.role === 'thought').map((e) => (e as { text: string }).text).join('')).toBe('Plane Schritte');
    expect(events).toContainEqual({ type: 'plan', entries: [{ text: 'Tests ausführen', status: 'in_progress' }, { text: 'Fixen', status: 'pending' }] });
    expect(events).toContainEqual({ type: 'tool.start', id: 'cmd_1', kind: 'exec', title: 'npm test', input: { command: 'npm test', cwd: '/workspace' } });

    h.respondApproval(req.id, 'accept');
    const done = await waitFor('turn.done');
    expect(done.stopReason).toBe('end_turn');
    expect(events).toContainEqual({ type: 'tool.update', id: 'cmd_1', output: 'ok 1\n' });
    expect(events).toContainEqual({ type: 'tool.done', id: 'cmd_1', status: 'completed', output: 'ok 1\nok 2\n' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.done', id: 'fc_1', status: 'completed' }));
    const diff = events.find((e) => e.type === 'diff.turn') as Extract<AgentEvent, { type: 'diff.turn' }>;
    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts', 'new.txt']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'message.done', id: 'msg_1', role: 'assistant', text: 'Fertig!' }));
    expect(events).toContainEqual({ type: 'usage', inputTokens: 200, outputTokens: 100, contextPercent: 30 });
    expect(stderr.find((l) => l.startsWith('turn/start'))).toContain('"approvalPolicy":"untrusted"');
  });

  it('declined approval, mode/model changes apply to the next turn', async () => {
    const { h, events, waitFor, stderr } = start('codex_app_server');
    await h.ready;
    await h.setMode!('full');
    await h.setModel!('gpt-x');
    await waitFor('session.info', (e) => e.currentMode === 'full' && e.currentModel === 'gpt-x');
    await h.prompt('los');
    const req = await waitFor('approval.request');
    h.respondApproval(req.id, 'decline');
    await waitFor('turn.done');
    expect(events).toContainEqual({ type: 'tool.done', id: 'cmd_1', status: 'failed' });
    expect(events).toContainEqual({ type: 'approval.resolved', id: req.id, optionId: 'decline' });
    expect(stderr.find((l) => l.startsWith('turn/start'))).toContain('"approvalPolicy":"never"');
    expect(stderr.find((l) => l.startsWith('turn/start'))).toContain('"model":"gpt-x"');
  });

  it('interrupts a running turn', async () => {
    const { h, waitFor } = start('codex_app_server');
    await h.ready;
    await h.prompt('slow');
    await waitFor('message.delta');
    await h.cancel();
    expect((await waitFor('turn.done')).stopReason).toBe('cancelled');
  });

  it('resumes a thread, falls back to a new one on failure', async () => {
    const a = start('codex_app_server', { resumeExternalId: 'thr_old' });
    await a.h.ready;
    expect(a.h.externalId).toBe('thr_old');
    const b = start('codex_app_server', { resumeExternalId: 'thr_missing' });
    await b.h.ready;
    expect(b.h.externalId).toBe('thr_new');
    expect(b.events.some((e) => e.type === 'error')).toBe(true);
  });
});

describe('helpers', () => {
  it('codexMcpArgs renders TOML overrides', () => {
    expect(codexMcpArgs([{ name: 'pw', command: 'npx', args: ['-y', 'a"b'], env: { K: 'v' } }])).toEqual([
      '-c', 'mcp_servers.pw.command="npx"',
      '-c', 'mcp_servers.pw.args=["-y", "a\\"b"]',
      '-c', 'mcp_servers.pw.env={ K = "v" }',
    ]);
  });

  it('splitUnifiedDiff splits per file', () => {
    const files = splitUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n-a\n+b\ndiff --git a/y b/y\ndeleted file mode 100644\n--- a/y\n+++ /dev/null\n@@\n-y\n');
    expect(files.map((f) => f.path)).toEqual(['x', 'y']);
    expect(files[1]!.unified).toContain('deleted file');
  });
});
