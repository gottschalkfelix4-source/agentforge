import type { ProviderKind, ProviderTestResult } from '@vibe/shared';
import { ANTHROPIC_BASE, GEMINI_BASE, ollamaRoot, openaiBase, anthropicRoot } from '../agents/providers/common.js';
import type { ProviderRecord } from '../routes/providers.js';

export interface ProviderProbe {
  kind: ProviderKind;
  baseUrl: string | null;
  apiKey: string;
}

type Fetch = typeof fetch;

interface Request {
  url: string;
  /** Extra request that must succeed first (key check for endpoints whose model list is public). */
  verifyUrl?: string;
  headers: Record<string, string>;
  pick: (body: unknown) => string[];
}

const ids = (list: unknown, field: string): string[] =>
  Array.isArray(list) ? list.map((m) => (m && typeof m === 'object' ? String((m as Record<string, unknown>)[field] ?? '') : '')).filter(Boolean) : [];

/** Which endpoint lists the models of a provider (and how to read the answer). */
export function modelsRequest(p: ProviderProbe): Request {
  const rec = { kind: p.kind, baseUrl: p.baseUrl } as ProviderRecord;
  switch (p.kind) {
    case 'ollama':
      return {
        url: `${ollamaRoot(rec)}/api/tags`,
        headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
        pick: (b) => ids((b as { models?: unknown }).models, 'name'),
      };
    case 'anthropic':
    case 'anthropic_compat':
      return {
        url: `${p.kind === 'anthropic' && !p.baseUrl ? ANTHROPIC_BASE : anthropicRoot(rec)}/v1/models?limit=1000`,
        headers: {
          'x-api-key': p.apiKey,
          'anthropic-version': '2023-06-01',
          // Anthropic-compatible gateways (OpenRouter, LiteLLM, …) often expect a bearer token instead.
          ...(p.kind === 'anthropic_compat' && p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
        },
        pick: (b) => ids((b as { data?: unknown }).data, 'id'),
      };
    case 'gemini':
      return {
        url: `${(p.baseUrl || GEMINI_BASE).replace(/\/+$/, '')}/v1beta/models?pageSize=1000`,
        headers: { 'x-goog-api-key': p.apiKey },
        pick: (b) => ids((b as { models?: unknown }).models, 'name').map((n) => n.replace(/^models\//, '')),
      };
    default:
      return {
        url: `${openaiBase(rec)}/models`,
        verifyUrl: p.kind === 'openrouter' ? `${openaiBase(rec)}/key` : undefined,
        headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
        pick: (b) => ids((b as { data?: unknown }).data, 'id'),
      };
  }
}

/** Probes a provider by listing its models (10 s timeout). Never throws; the key never appears in errors. */
export async function testProvider(p: ProviderProbe, fetchImpl: Fetch = fetch, timeoutMs = 10_000): Promise<ProviderTestResult> {
  let req: Request;
  try {
    req = modelsRequest(p);
  } catch (err) {
    return { ok: false, error: `Ungültige Base-URL: ${(err as Error).message}` };
  }
  const redact = (s: string) => (p.apiKey ? s.split(p.apiKey).join('***') : s);
  try {
    if (req.verifyUrl) {
      const v = await fetchImpl(req.verifyUrl, { headers: { Accept: 'application/json', ...req.headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (!v.ok) return { ok: false, error: `HTTP ${v.status}: API-Key wurde abgelehnt` };
    }
    const res = await fetchImpl(req.url, { headers: { Accept: 'application/json', ...req.headers }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? detail;
      } catch {
        /* keep raw text */
      }
      const hint = res.status === 401 || res.status === 403 ? ' (API-Key prüfen)' : '';
      return { ok: false, error: redact(`HTTP ${res.status}${hint}: ${detail}`.trim()) };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Antwort ist kein JSON – stimmt die Base-URL?' };
    }
    const models = [...new Set(req.pick(body))].sort((a, b) => a.localeCompare(b));
    return { ok: true, models };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { ok: false, error: `Zeitüberschreitung nach ${timeoutMs / 1000} s (${new URL(req.url).host})` };
    const cause = e.cause?.code ?? e.cause?.message ?? e.message;
    return { ok: false, error: redact(`Nicht erreichbar (${new URL(req.url).host}): ${cause}`) };
  }
}
