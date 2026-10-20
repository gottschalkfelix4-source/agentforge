// Model catalog of providers that publish one with prices (OpenRouter's /models: name, context length, USD per
// token). The chat model picker shows it; SessionService prices the tokens of OpenRouter sessions with it, since
// the agents either report no cost or compute it with their own vendor's prices.

import type { ModelCatalogEntry, ModelPricing, SpentTokens } from '@vibe/shared';
import type { ProviderRecord } from '../../routes/providers.js';
import { openaiBase } from './common.js';

type Fetch = typeof fetch;

const TTL_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

interface Catalog {
  models: Map<string, ModelCatalogEntry> | null;
  at: number;
  loading: Promise<void> | null;
}

const catalogs = new Map<string, Catalog>();

type CatalogProvider = Pick<ProviderRecord, 'kind' | 'baseUrl'>;

/** Whether the provider publishes prices Agentforge can use. */
export const hasCatalog = (p: CatalogProvider | null | undefined): boolean => p?.kind === 'openrouter';

const catalogKey = (p: CatalogProvider) => openaiBase(p as ProviderRecord);

/** USD per token; OpenRouter sends strings and "-1" for variable-priced routers. */
function perToken(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

/** Entries of an OpenRouter-style `/models` response, keyed by model id. */
export function parseCatalog(body: unknown): Map<string, ModelCatalogEntry> {
  const out = new Map<string, ModelCatalogEntry>();
  const list = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) continue;
    const p = (m.pricing ?? {}) as Record<string, unknown>;
    const prompt = perToken(p.prompt);
    const completion = perToken(p.completion);
    const pricing: ModelPricing | null =
      prompt !== null && completion !== null
        ? { prompt, completion, cacheRead: perToken(p.input_cache_read), cacheWrite: perToken(p.input_cache_write) }
        : null;
    const top = m.top_provider as Record<string, unknown> | undefined;
    out.set(m.id, {
      id: m.id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : null,
      contextLength: positive(m.context_length) ?? positive(top?.context_length),
      pricing,
    });
  }
  return out;
}

function refresh(p: CatalogProvider, fetchImpl: Fetch): Promise<void> {
  const key = catalogKey(p);
  const c = catalogs.get(key) ?? { models: null, at: 0, loading: null };
  catalogs.set(key, c);
  if (c.loading) return c.loading;
  c.loading = (async () => {
    try {
      const res = await fetchImpl(`${key}/models`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const models = parseCatalog(await res.json());
      if (models.size) c.models = models;
      c.at = Date.now();
    } catch {
      // Keep what we had; try again in a few minutes.
      c.at = Date.now() - TTL_MS + RETRY_MS;
    } finally {
      c.loading = null;
    }
  })();
  return c.loading;
}

function stale(c: Catalog | undefined): boolean {
  return !c || Date.now() - c.at >= TTL_MS;
}

/** Starts loading the catalog in the background (session start), no-op when fresh. */
export function warmCatalog(p: CatalogProvider | null | undefined, fetchImpl: Fetch = fetch): void {
  if (!hasCatalog(p)) return;
  const c = catalogs.get(catalogKey(p!));
  if (stale(c) && !c?.loading) void refresh(p!, fetchImpl);
}

/** The provider's catalog (waits for the first load; afterwards refreshes in the background); null without one. */
export async function providerCatalog(p: CatalogProvider, fetchImpl: Fetch = fetch): Promise<Map<string, ModelCatalogEntry> | null> {
  if (!hasCatalog(p)) return null;
  const key = catalogKey(p);
  if (!catalogs.get(key)?.models) await refresh(p, fetchImpl);
  else warmCatalog(p, fetchImpl);
  return catalogs.get(key)?.models ?? new Map();
}

/**
 * Pricing of `model` from the cached catalog, synchronous (ingest path): undefined while the catalog is not loaded
 * (a load is started), null when the provider does not price this model.
 */
export function cachedPricing(p: CatalogProvider | null | undefined, model: string | null | undefined, fetchImpl: Fetch = fetch): ModelPricing | null | undefined {
  if (!hasCatalog(p) || !model) return null;
  warmCatalog(p, fetchImpl);
  const models = catalogs.get(catalogKey(p!))?.models;
  if (!models) return undefined;
  return models.get(model)?.pricing ?? null;
}

/** USD for the tokens; cache reads/writes fall back to the input price when the provider lists none. */
export function priceTokens(spent: SpentTokens, pricing: ModelPricing): number {
  return (
    spent.input * pricing.prompt +
    spent.cachedInput * (pricing.cacheRead ?? pricing.prompt) +
    spent.cacheWrite * (pricing.cacheWrite ?? pricing.prompt) +
    spent.output * pricing.completion
  );
}

/** Test hook. */
export function clearCatalogCache() {
  catalogs.clear();
}
