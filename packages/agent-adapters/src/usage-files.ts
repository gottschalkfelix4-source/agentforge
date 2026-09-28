// Context usage from an agent's own session files, for agents whose ACP side reports none (Cline) or only
// per-turn sums (Gemini CLI). Each reader returns the tokens of the latest main-conversation model request
// (prompt + answer = what the next request starts with), or null when nothing is recorded (yet).

import fs from 'node:fs/promises';
import path from 'node:path';

type Reader = (externalId: string, home: string) => Promise<number | null>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Last `maxBytes` of a file (session logs grow with the conversation; only the end matters). */
async function tail(file: string, maxBytes = 512 * 1024): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Cline ≥ 3: ~/.cline/data/sessions/<id>/<id>.messages.json, assistant messages carry `metrics`. */
const cline: Reader = async (id, home) => {
  if (!/^[\w.-]+$/.test(id)) return null;
  const file = path.join(home, '.cline', 'data', 'sessions', id, `${id}.messages.json`);
  const data = JSON.parse(await fs.readFile(file, 'utf8')) as { messages?: { role?: string; metrics?: Record<string, unknown> }[] };
  const last = [...(data.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.metrics);
  if (!last?.metrics) return null;
  const m = last.metrics;
  return num(m.inputTokens) + num(m.cacheReadTokens) + num(m.cacheWriteTokens) + num(m.outputTokens) || null;
};

/** Gemini CLI: ~/.gemini/tmp/<project>/chats/session-<time>-<id first 8>.jsonl, `gemini` records carry `tokens`. */
const gemini: Reader = async (id, home) => {
  const short = id.slice(0, 8);
  if (!/^[\w-]+$/.test(short)) return null;
  const tmp = path.join(home, '.gemini', 'tmp');
  let newest: { file: string; mtime: number } | null = null;
  for (const project of await fs.readdir(tmp).catch(() => [] as string[])) {
    const dir = path.join(tmp, project, 'chats');
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith('session-') || !(name.endsWith(`-${short}.jsonl`) || name.endsWith(`-${short}.json`))) continue;
      const file = path.join(dir, name);
      const { mtimeMs } = await fs.stat(file);
      if (!newest || mtimeMs > newest.mtime) newest = { file, mtime: mtimeMs };
    }
  }
  if (!newest) return null;
  const text = await tail(newest.file);
  // JSONL (one record per line, updated messages are appended again); legacy .json holds `messages`.
  let records: unknown[];
  if (newest.file.endsWith('.json')) {
    records = ((JSON.parse(text) as { messages?: unknown[] }).messages ?? []);
  } else {
    records = text.split('\n').flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return []; // first line of the tail may be cut off
      }
    });
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as { type?: string; tokens?: Record<string, unknown> } | null;
    if (r?.type === 'gemini' && r.tokens) return num(r.tokens.input) + num(r.tokens.output) || null;
  }
  return null;
};

const READERS: Record<string, Reader> = { cline, gemini };

/** Agents whose context usage comes from their session files. */
export const hasSessionFileUsage = (agentId: string | undefined): boolean => !!agentId && agentId in READERS;

/** Tokens currently in the context according to the agent's session files; null if unknown. Never throws. */
export async function sessionFileContext(agentId: string, externalId: string, home: string): Promise<number | null> {
  const read = READERS[agentId];
  if (!read) return null;
  try {
    return await read(externalId, home);
  } catch {
    return null;
  }
}
