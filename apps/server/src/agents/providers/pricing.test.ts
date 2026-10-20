import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedPricing, clearCatalogCache, parseCatalog, priceTokens, providerCatalog } from './pricing.js';

const body = {
  data: [
    {
      id: 'anthropic/claude-opus-4.1',
      name: 'Anthropic: Claude Opus 4.1',
      context_length: 200_000,
      pricing: { prompt: '0.000015', completion: '0.000075', input_cache_read: '0.0000015', input_cache_write: '0.00001875' },
    },
    { id: 'openrouter/auto', name: 'Auto Router', context_length: 2_000_000, pricing: { prompt: '-1', completion: '-1' } },
    { id: 'deepseek/deepseek-v4.1-flash:free', name: 'DeepSeek: V4.1 Flash (free)', top_provider: { context_length: 128_000 }, pricing: { prompt: '0', completion: '0' } },
    { name: 'no id' },
  ],
};

const openrouter = { kind: 'openrouter' as const, baseUrl: null };

afterEach(() => clearCatalogCache());

describe('model catalog', () => {
  it('parses names, context lengths and per-token prices', () => {
    const m = parseCatalog(body);
    expect(m.size).toBe(3);
    expect(m.get('anthropic/claude-opus-4.1')).toEqual({
      id: 'anthropic/claude-opus-4.1',
      name: 'Anthropic: Claude Opus 4.1',
      contextLength: 200_000,
      pricing: { prompt: 0.000015, completion: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
    });
    expect(m.get('openrouter/auto')!.pricing).toBeNull();
    expect(m.get('deepseek/deepseek-v4.1-flash:free')).toMatchObject({ contextLength: 128_000, pricing: { prompt: 0, completion: 0, cacheRead: null } });
  });

  it('prices tokens, cache falling back to the input price', () => {
    const p = { prompt: 0.000002, completion: 0.00001, cacheRead: null, cacheWrite: null };
    expect(priceTokens({ input: 1000, cachedInput: 1000, cacheWrite: 1000, output: 100 }, p)).toBeCloseTo(0.007);
  });

  it('loads once, answers synchronously from the cache and only for catalog providers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
    expect(cachedPricing({ kind: 'openai', baseUrl: null }, 'gpt-5', fetchImpl)).toBeNull();
    expect(cachedPricing(openrouter, 'anthropic/claude-opus-4.1', fetchImpl)).toBeUndefined(); // starts the load
    const models = await providerCatalog(openrouter, fetchImpl);
    expect(models!.size).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models');
    expect(cachedPricing(openrouter, 'anthropic/claude-opus-4.1', fetchImpl)?.prompt).toBe(0.000015);
    expect(cachedPricing(openrouter, 'unknown/model', fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await providerCatalog({ kind: 'anthropic', baseUrl: null }, fetchImpl)).toBeNull();
  });

  it('survives a failing catalog', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    expect((await providerCatalog(openrouter, fetchImpl))!.size).toBe(0);
    expect(cachedPricing(openrouter, 'x', fetchImpl)).toBeUndefined();
  });
});
