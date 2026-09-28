// Context window (tokens) of a provider model, asked from the provider itself. Agents only know the windows of
// models they ship a catalog for; for local servers (LM Studio, Ollama, llama.cpp) and gateways they fall back to
// a default guess (Claude Code 200k/1M, Codex 258k, Goose/Copilot 128k), so both the context display and the
// agents' own auto-compaction are off. The resolved value is handed to the agent (env/config) and to the adapter.

import type { ProviderKind } from '@vibe/shared';
import type { ProviderRecord } from '../../routes/providers.js';
import { ANTHROPIC_BASE, GEMINI_BASE, OPENROUTER_OPENAI, anthropicRoot, ollamaRoot, openaiBase } from './common.js';

type Fetch = typeof fetch;

export interface WindowProbe {
  kind: ProviderKind;
  baseUrl: string | null;
  apiKey: string;
  model: string;
}

const TIMEOUT_MS = 2500;
const CACHE_MS = 60_000;
const cache = new Map<string, { value: number | null; at: number }>();

const trimSlash = (u: string) => u.replace(/\/+$/, '');
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

async function getJson(fetchImpl: Fetch, url: string, headers: Record<string, string>, init?: RequestInit): Promise<unknown> {
  try {
    const res = await fetchImpl(url, { ...init, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Model entries of an OpenAI-style list (`data`), LM Studio v1 (`models`) or a bare array. */
function entries(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body) ? body : ((body as { data?: unknown; models?: unknown } | null)?.data ?? (body as { models?: unknown } | null)?.models);
  return Array.isArray(list) ? list.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object') : [];
}

const sameModel = (entry: Record<string, unknown>, model: string) =>
  [entry.id, entry.key, entry.name, entry.model].some((v) => typeof v === 'string' && (v === model || v === `${model}:latest` || v.replace(/^models\//, '') === model));

/** Context-size fields servers put on their model entries (vLLM, OpenRouter, LM Studio, LiteLLM, Together, …). */
function windowField(e: Record<string, unknown>): number | null {
  const top = e.top_provider as Record<string, unknown> | undefined;
  const meta = e.meta as Record<string, unknown> | undefined;
  return (
    positive(e.loaded_context_length) ??
    positive(e.context_length) ??
    positive(e.max_context_length) ??
    positive(e.context_window) ??
    positive(e.max_model_len) ??
    positive(e.max_input_tokens) ??
    positive(e.inputTokenLimit) ??
    positive(top?.context_length) ??
    positive(meta?.n_ctx) ??
    null
  );
}

const bearer = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

/** LM Studio's native API knows the context the model is actually loaded with. */
async function lmStudio(f: Fetch, root: string, p: WindowProbe): Promise<number | null> {
  const e = entries(await getJson(f, `${root}/api/v0/models`, bearer(p.apiKey))).find((m) => sameModel(m, p.model));
  return e ? (positive(e.loaded_context_length) ?? positive(e.max_context_length)) : null;
}

/** Ollama: the running model's allocated context (`/api/ps`), else a `num_ctx` baked into the model. */
async function ollama(f: Fetch, root: string, p: WindowProbe): Promise<number | null> {
  const running = entries(await getJson(f, `${root}/api/ps`, bearer(p.apiKey))).find((m) => sameModel(m, p.model));
  const loaded = running ? positive(running.context_length) : null;
  if (loaded) return loaded;
  const show = (await getJson(f, `${root}/api/show`, { ...bearer(p.apiKey), 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ model: p.model }) })) as {
    parameters?: unknown;
  } | null;
  const m = typeof show?.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(show.parameters) : null;
  return m ? positive(Number(m[1])) : null;
}

/** llama.cpp server: the configured context size. */
async function llamaCpp(f: Fetch, root: string, p: WindowProbe): Promise<number | null> {
  const props = (await getJson(f, `${root}/props`, bearer(p.apiKey))) as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown } | null;
  return positive(props?.default_generation_settings?.n_ctx) ?? positive(props?.n_ctx);
}

async function modelList(f: Fetch, base: string, p: WindowProbe, headers: Record<string, string>): Promise<number | null> {
  const e = entries(await getJson(f, `${base}/models`, headers)).find((m) => sameModel(m, p.model));
  return e ? windowField(e) : null;
}

/** First non-null result in priority order; the probes run in parallel. */
async function first(probes: Promise<number | null>[]): Promise<number | null> {
  for (const v of await Promise.all(probes)) if (v) return v;
  return null;
}

async function probe(p: WindowProbe, f: Fetch): Promise<number | null> {
  const rec = { kind: p.kind, baseUrl: p.baseUrl } as ProviderRecord;
  switch (p.kind) {
    case 'ollama':
      return ollama(f, ollamaRoot(rec), p);
    case 'openrouter':
      return modelList(f, p.baseUrl ? openaiBase(rec) : OPENROUTER_OPENAI, p, {});
    case 'gemini': {
      const body = (await getJson(f, `${trimSlash(p.baseUrl || GEMINI_BASE)}/v1beta/models/${encodeURIComponent(p.model)}`, { 'x-goog-api-key': p.apiKey })) as Record<string, unknown> | null;
      return body ? positive(body.inputTokenLimit) : null;
    }
    case 'anthropic': {
      const root = p.baseUrl ? anthropicRoot(rec) : ANTHROPIC_BASE;
      const body = (await getJson(f, `${root}/v1/models/${encodeURIComponent(p.model)}`, { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' })) as Record<string, unknown> | null;
      return body ? windowField(body) : null;
    }
    case 'openai_compat':
    case 'anthropic_compat':
    case 'openai': {
      // Self-hosted or gateway: try what the common local servers expose, then the generic model list.
      if (p.kind === 'openai' && !p.baseUrl) return null;
      const base = p.kind === 'anthropic_compat' ? `${anthropicRoot(rec)}/v1` : openaiBase(rec);
      const root = base.replace(/\/v1$/, '');
      const headers = p.kind === 'anthropic_compat' ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', ...bearer(p.apiKey) } : bearer(p.apiKey);
      return first([lmStudio(f, root, p), ollama(f, root, p), modelList(f, base, p, headers), llamaCpp(f, root, p)]);
    }
    default:
      return null;
  }
}

/**
 * Context window of `model` at the provider in tokens, or null when the provider does not tell (the agent's own
 * value applies then). Cached for a minute; never throws.
 */
export async function resolveContextWindow(p: WindowProbe, fetchImpl: Fetch = fetch): Promise<number | null> {
  if (!p.model) return null;
  const key = `${p.kind}|${p.baseUrl ?? ''}|${p.model}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: number | null = null;
  try {
    value = await probe(p, fetchImpl);
  } catch {
    value = null;
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

/** Test hook. */
export function clearContextWindowCache() {
  cache.clear();
}
