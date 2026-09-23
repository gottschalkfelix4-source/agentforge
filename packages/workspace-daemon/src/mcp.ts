// `agentforge-mcp`: MCP server (stdio, newline-delimited JSON-RPC) that gives coding agents access to the
// Agentforge project board — tasks and their status, roadmap milestones and notes. Started by the agents
// (injected into every chat session); calls go through wsd (`POST /app-call`) to the app server.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AGENT_TOOL_NAMES, AGENT_TOOLS } from '@vibe/shared';

const VERSION = '1.0.0';
const port = Number(process.env.WSD_PORT ?? 7777);
const sessionId = process.env.AGENTFORGE_SESSION_ID || null;

function token(): string | null {
  for (const file of ['/run/wsd/token', process.env.WSD_TOKEN_FILE, '/run/vibe/wsd-token']) {
    if (!file) continue;
    try {
      const t = readFileSync(file, 'utf8').trim();
      if (t) return t;
    } catch {
      /* next */
    }
  }
  return process.env.WSD_TOKEN || null;
}

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callTool(name: string, args: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });
  if (!AGENT_TOOL_NAMES.has(name)) return text(`Unbekanntes Tool: ${name}`, true);
  const t = token();
  if (!t) return text('Agentforge-Token nicht gefunden – läuft dieser Prozess im Workspace?', true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/app-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ method: name, params: args ?? {}, sessionId }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) return text(body.error ?? `Fehler ${res.status}`, true);
    return text(typeof body.result === 'string' ? body.result : JSON.stringify(body.result, null, 2));
  } catch (err) {
    return text(`Agentforge nicht erreichbar: ${(err as Error).message}`, true);
  }
}

async function handle(msg: { id?: number | string; method?: string; params?: Record<string, unknown> }) {
  if (msg.id === undefined || msg.id === null) return; // notifications (initialized, cancelled, …)
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agentforge', title: 'Agentforge', version: VERSION },
        instructions:
          'Agentforge project board of this workspace: tasks with status columns (backlog, todo, in_progress, review, done), roadmap milestones and project notes. Keep the board current: set tasks you work on to in_progress and to review/done when finished, add follow-up tasks, and record decisions in notes.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: AGENT_TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      return reply(await callTool(name, msg.params?.arguments));
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  void handle(msg).catch((err: Error) => send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: err.message } }));
});
rl.on('close', () => process.exit(0));
