import type { Turn } from './transcript';

export type ContextPartKey = 'user' | 'assistant' | 'tools' | 'rest';

export interface ContextPart {
  key: ContextPartKey;
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  parts: ContextPart[];
  /** The transcript is larger than the context: the agent compacted/dropped history, parts are scaled down. */
  compacted: boolean;
}

/** Rough tokens of a text (≈ 4 characters per token). */
const tokensOf = (chars: number) => Math.ceil(chars / 4);
/** Rough tokens of an attached image. */
const IMAGE_TOKENS = 1_200;

function inputChars(input: unknown): number {
  if (input === undefined || input === null) return 0;
  if (typeof input === 'string') return input.length;
  try {
    return JSON.stringify(input).length;
  } catch {
    return 0;
  }
}

/**
 * Estimated split of the `used` context tokens from the transcript: user prompts, the agent's answers and thoughts,
 * tool calls with their results; the remainder is the system prompt, tool definitions and whatever the transcript
 * does not show. Sub-agent steps run in their own context and are left out.
 */
export function contextBreakdown(turns: Turn[], used: number): ContextBreakdown {
  let user = 0;
  let assistant = 0;
  let tools = 0;
  for (const t of turns) {
    for (const it of t.items) {
      if ('parentId' in it && it.parentId) continue;
      if (it.kind === 'user') user += tokensOf(it.text.length) + (it.images?.length ?? 0) * IMAGE_TOKENS;
      else if (it.kind === 'message') assistant += tokensOf(it.text.length);
      else if (it.kind === 'tool') tools += tokensOf(it.title.length + inputChars(it.input) + it.output.length);
      else if (it.kind === 'question') tools += tokensOf(it.message.length);
    }
  }
  const sum = user + assistant + tools;
  const compacted = sum > used;
  const f = compacted && sum > 0 ? used / sum : 1;
  const parts: ContextPart[] = [
    { key: 'user', label: 'Deine Nachrichten', tokens: Math.round(user * f) },
    { key: 'assistant', label: 'Antworten & Denken', tokens: Math.round(assistant * f) },
    { key: 'tools', label: 'Tool-Aufrufe & Ergebnisse', tokens: Math.round(tools * f) },
  ];
  const known = parts.reduce((a, p) => a + p.tokens, 0);
  parts.push({ key: 'rest', label: 'System-Prompt, Tools & Rest', tokens: Math.max(0, used - known) });
  return { parts, compacted };
}
