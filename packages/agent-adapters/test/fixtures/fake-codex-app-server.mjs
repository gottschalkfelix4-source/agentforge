#!/usr/bin/env node
// Fake `codex app-server` for tests. Like the real one, messages carry no "jsonrpc" field.
//   prompt "slow" → streams until turn/interrupt; anything else → full turn with an approval.
import readline from 'node:readline';

process.stderr.write(`argv ${JSON.stringify(process.argv.slice(2))}\n`);

let nextId = 5000;
const pending = new Map();
let interrupted = false;
let turnN = 0;
const threadId = 'thr_new';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(tid, turnId, text, params) {
  process.stderr.write(`turn/start ${JSON.stringify({ approvalPolicy: params.approvalPolicy, sandboxPolicy: params.sandboxPolicy, model: params.model ?? null })}\n`);
  const base = { threadId: tid, turnId };
  notify('turn/started', { threadId: tid, turn: { id: turnId, status: 'inProgress', error: null, items: [] } });
  if (text.includes('slow')) {
    notify('item/started', { ...base, item: { type: 'agentMessage', id: 'msg_slow', text: '' } });
    for (let i = 0; i < 200 && !interrupted; i++) {
      notify('item/agentMessage/delta', { ...base, itemId: 'msg_slow', delta: '.' });
      await sleep(20);
    }
    notify('turn/completed', { threadId: tid, turn: { id: turnId, status: interrupted ? 'interrupted' : 'completed', error: null, items: [] } });
    return;
  }
  notify('item/started', { ...base, item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] } });
  notify('item/reasoning/summaryTextDelta', { ...base, itemId: 'rs_1', delta: 'Plane ', summaryIndex: 0 });
  notify('item/reasoning/textDelta', { ...base, itemId: 'rs_1', delta: 'RAW', contentIndex: 0 });
  notify('item/reasoning/summaryTextDelta', { ...base, itemId: 'rs_1', delta: 'Schritte', summaryIndex: 0 });
  notify('item/completed', { ...base, item: { type: 'reasoning', id: 'rs_1', summary: ['Plane Schritte'], content: ['RAW'] } });

  notify('turn/plan/updated', { ...base, explanation: null, plan: [{ step: 'Tests ausführen', status: 'inProgress' }, { step: 'Fixen', status: 'pending' }] });

  notify('item/started', { ...base, item: { type: 'commandExecution', id: 'cmd_1', command: 'npm test', cwd: '/workspace', status: 'inProgress', aggregatedOutput: null, exitCode: null } });
  const approval = await request('item/commandExecution/requestApproval', { ...base, itemId: 'cmd_1', startedAtMs: Date.now(), command: 'npm test', cwd: '/workspace', reason: 'Tests laufen lassen' });
  if (approval.decision === 'accept' || approval.decision === 'acceptForSession') {
    notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd_1', delta: 'ok 1\n' });
    notify('item/commandExecution/outputDelta', { ...base, itemId: 'cmd_1', delta: 'ok 2\n' });
    notify('item/completed', { ...base, item: { type: 'commandExecution', id: 'cmd_1', command: 'npm test', cwd: '/workspace', status: 'completed', aggregatedOutput: 'ok 1\nok 2\n', exitCode: 0 } });
  } else {
    notify('item/completed', { ...base, item: { type: 'commandExecution', id: 'cmd_1', command: 'npm test', cwd: '/workspace', status: 'declined', aggregatedOutput: null, exitCode: null } });
  }

  const changes = [{ path: '/workspace/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }];
  notify('item/started', { ...base, item: { type: 'fileChange', id: 'fc_1', changes, status: 'inProgress' } });
  notify('item/completed', { ...base, item: { type: 'fileChange', id: 'fc_1', changes, status: 'completed' } });
  notify('turn/diff/updated', {
    ...base,
    diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+x\n',
  });

  notify('item/started', { ...base, item: { type: 'agentMessage', id: 'msg_1', text: '' } });
  notify('item/agentMessage/delta', { ...base, itemId: 'msg_1', delta: 'Fertig' });
  notify('item/agentMessage/delta', { ...base, itemId: 'msg_1', delta: '!' });
  notify('item/completed', { ...base, item: { type: 'agentMessage', id: 'msg_1', text: 'Fertig!' } });
  const bd = { totalTokens: 300, inputTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
  notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: bd, last: bd, modelContextWindow: 1000 } });
  notify('turn/completed', { threadId: tid, turn: { id: turnId, status: 'completed', error: null, items: [] } });
}

function handle(msg) {
  const { method, params } = msg;
  switch (method) {
    case 'initialize':
      return { userAgent: 'fake-codex/0.0.0', codexHome: '/home/coder/.codex', platformFamily: 'unix', platformOs: 'linux' };
    case 'thread/start':
      process.stderr.write(`thread/start ${JSON.stringify(params)}\n`);
      return { thread: { id: threadId, model: params.model ?? 'gpt-fake', cwd: params.cwd, name: null }, model: params.model ?? 'gpt-fake', approvalPolicy: params.approvalPolicy, sandbox: { type: 'dangerFullAccess' } };
    case 'thread/resume':
      if (params.threadId !== 'thr_old') throw Object.assign(new Error('no rollout found'), { code: -32600 });
      return { thread: { id: 'thr_old', model: 'gpt-fake', cwd: params.cwd, name: null }, model: 'gpt-fake', approvalPolicy: params.approvalPolicy, sandbox: { type: 'dangerFullAccess' } };
    case 'model/list':
      return { data: [{ id: 'gpt-fake', model: 'gpt-fake', displayName: 'GPT Fake', hidden: false, isDefault: true }], nextCursor: null };
    case 'turn/start': {
      interrupted = false;
      const turnId = `turn_${++turnN}`;
      const text = params.input.filter((i) => i.type === 'text').map((i) => i.text).join('');
      setTimeout(() => void runTurn(params.threadId, turnId, text, params), 5);
      return { turn: { id: turnId, status: 'inProgress', error: null, items: [] } };
    }
    case 'turn/interrupt':
      interrupted = true;
      return {};
    default:
      throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method && msg.id !== undefined) {
    try {
      send({ id: msg.id, result: handle(msg) });
    } catch (err) {
      send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  } else if (msg.method) {
    process.stderr.write(`notification ${msg.method}\n`);
  } else {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg.result);
    }
  }
});
rl.on('close', () => process.exit(0));
