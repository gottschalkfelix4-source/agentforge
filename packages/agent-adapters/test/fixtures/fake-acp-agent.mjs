#!/usr/bin/env node
// Fake ACP agent for tests (no dependencies). Speaks newline-delimited JSON-RPC on stdio.
// Prompt text controls the scenario:
//   "slow"     → streams until session/cancel arrives, then stopReason "cancelled"
//   "crash"    → exits with code 3 mid-turn
//   anything else → thought, message, tool call with permission request, fs round-trip, plan, usage
import readline from 'node:readline';

let nextId = 1000;
const pending = new Map();
const sessions = new Set(['persisted-1']);
let cancelled = false;
let mode = 'default';
let model = 'fast';

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const configOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: 'fast', name: 'Fast' },
      { value: 'smart', name: 'Smart' },
    ],
  },
];
const modes = () => ({
  currentModeId: mode,
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan', description: 'Plan only' },
  ],
});

let clientCaps = {};

async function runPrompt(sessionId, text) {
  cancelled = false;
  if (text.includes('ask')) {
    // Claude Code style AskUserQuestion → ACP form elicitation (only when the client supports it).
    if (!clientCaps.elicitation?.form) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'no elicitation' } });
      return { stopReason: 'end_turn' };
    }
    const res = await request('elicitation/create', {
      mode: 'form',
      sessionId,
      toolCallId: 'ask1',
      message: 'Welche Datenbank?',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: {
            type: 'string',
            title: 'DB',
            oneOf: [
              { const: 'SQLite', title: 'SQLite', description: 'Eingebettet' },
              { const: 'Postgres', title: 'Postgres', _meta: { 'x/opt': { preview: 'CREATE TABLE …' } } },
            ],
          },
          q0_custom: { type: 'string', title: 'Other', _meta: { 'x/custom': { questionId: 'q0', isCustomAnswer: true } } },
        },
      },
    });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Antwort: ' + JSON.stringify(res) } });
    return { stopReason: 'end_turn' };
  }
  if (text.includes('slow')) {
    for (let i = 0; i < 200 && !cancelled; i++) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } });
      await sleep(20);
    }
    return { stopReason: cancelled ? 'cancelled' : 'end_turn' };
  }
  if (text.includes('ticks')) {
    // Non-delta events over ~6s (used to test backfill while the app server is down).
    for (let i = 1; i <= 40 && !cancelled; i++) {
      update(sessionId, { sessionUpdate: 'plan', entries: [{ content: `Schritt ${i}`, priority: 'medium', status: 'in_progress' }] });
      await sleep(150);
    }
    return { stopReason: cancelled ? 'cancelled' : 'end_turn' };
  }
  if (text.includes('crash')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to crash' } });
    await sleep(20);
    process.exit(3);
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Ich denke ' } });
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'nach.' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hallo ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Welt' } });
  update(sessionId, {
    sessionUpdate: 'plan',
    entries: [
      { content: 'Dateien auflisten', priority: 'high', status: 'in_progress' },
      { content: 'Datei schreiben', priority: 'medium', status: 'pending' },
    ],
  });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc1',
    title: 'ls -la',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'ls -la' },
  });
  const perm = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'tc1', title: 'ls -la', kind: 'execute', rawInput: { command: 'ls -la' } },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const allowed = perm.outcome.outcome === 'selected' && perm.outcome.optionId !== 'reject';
  if (!allowed) {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'failed' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Abgelehnt.' } });
    return { stopReason: cancelled ? 'cancelled' : 'end_turn' };
  }
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'a\n' } }] });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', content: [{ type: 'content', content: { type: 'text', text: 'a\nb\n' } }] });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a\nb\nc\n' } }] });

  // fs round trip through the client
  await request('fs/write_text_file', { sessionId, path: `${process.cwd()}/fake-out.txt`, content: 'line1\nline2\nline3' });
  const read = await request('fs/read_text_file', { sessionId, path: `${process.cwd()}/fake-out.txt`, line: 2, limit: 1 });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc2',
    title: 'Edit fake-out.txt',
    kind: 'edit',
    status: 'completed',
    locations: [{ path: `${process.cwd()}/fake-out.txt` }],
    content: [{ type: 'diff', path: `${process.cwd()}/fake-out.txt`, oldText: null, newText: 'line1\nline2\nline3' }],
  });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Gelesen: ${read.content}` } });
  update(sessionId, { sessionUpdate: 'usage_update', used: 500, size: 1000, cost: { amount: 0.01, currency: 'USD' } });
  return { stopReason: 'end_turn', usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } };
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      clientCaps = params.clientCapabilities ?? {};
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        agentInfo: { name: 'fake-acp', version: '1.0.0' },
      };
    case 'session/new': {
      const sessionId = `fake-${Date.now()}`;
      sessions.add(sessionId);
      setTimeout(() => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review code' }] }), 5);
      return { sessionId, modes: modes(), configOptions: configOptions(), mcpCount: params.mcpServers.length };
    }
    case 'session/load': {
      if (!sessions.has(params.sessionId)) throw Object.assign(new Error('session not found'), { code: -32002 });
      // History replay (the client must ignore it).
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
      await sleep(10);
      return { modes: modes(), configOptions: configOptions() };
    }
    case 'session/prompt': {
      const text = params.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return runPrompt(params.sessionId, text);
    }
    case 'session/set_mode':
      mode = params.modeId;
      update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode });
      return {};
    case 'session/set_config_option':
      if (params.configId === 'model') model = params.value;
      return { configOptions: configOptions() };
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method && msg.id !== undefined) {
    Promise.resolve()
      .then(() => handle(msg))
      .then(
        (result) => send({ id: msg.id, result }),
        (err) => send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } }),
      );
  } else if (msg.method) {
    if (msg.method === 'session/cancel') cancelled = true;
  } else {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
});
rl.on('close', () => process.exit(0));
process.stderr.write('fake-acp ready\n');
