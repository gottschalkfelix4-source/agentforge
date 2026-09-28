import { beforeEach, describe, expect, it } from 'vitest';
import { clearContextWindowCache, resolveContextWindow } from './context-window.js';

type Routes = Record<string, unknown>;

/** Fake fetch answering `METHOD url` (or just `url`) from a table; everything else is a 404. */
function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    const body = key in routes ? routes[key] : routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

beforeEach(() => clearContextWindowCache());

describe('resolveContextWindow', () => {
  it('LM Studio: the loaded context wins over the model maximum', async () => {
    const { f } = fakeFetch({
      'http://lm:1234/api/v0/models': {
        data: [
          { id: 'ornith-1.5-9b', state: 'loaded', max_context_length: 262144, loaded_context_length: 132096 },
          { id: 'qwen3.6-35b-a3b', state: 'not-loaded', max_context_length: 262144 },
        ],
      },
      'http://lm:1234/v1/models': { data: [{ id: 'ornith-1.5-9b' }] },
    });
    expect(await resolveContextWindow({ kind: 'openai_compat', baseUrl: 'http://lm:1234/v1', apiKey: '', model: 'ornith-1.5-9b' }, f)).toBe(132096);
    expect(await resolveContextWindow({ kind: 'anthropic_compat', baseUrl: 'http://lm:1234', apiKey: '', model: 'qwen3.6-35b-a3b' }, f)).toBe(262144);
  });

  it('Ollama: allocated context of the running model, else num_ctx of the model', async () => {
    const { f } = fakeFetch({
      'http://ol:11434/api/ps': { models: [{ name: 'qwen3:latest', model: 'qwen3:latest', context_length: 32768 }] },
      'POST http://ol:11434/api/show': { parameters: 'temperature 0.7\nnum_ctx 16384' },
    });
    expect(await resolveContextWindow({ kind: 'ollama', baseUrl: 'http://ol:11434', apiKey: '', model: 'qwen3' }, f)).toBe(32768);
    expect(await resolveContextWindow({ kind: 'ollama', baseUrl: 'http://ol:11434/v1', apiKey: '', model: 'llama3' }, f)).toBe(16384);
  });

  it('llama.cpp server: n_ctx from /props', async () => {
    const { f } = fakeFetch({ 'http://lc:8080/props': { default_generation_settings: { n_ctx: 65536 } }, 'http://lc:8080/v1/models': { data: [{ id: 'm' }] } });
    expect(await resolveContextWindow({ kind: 'openai_compat', baseUrl: 'http://lc:8080/v1', apiKey: '', model: 'm' }, f)).toBe(65536);
  });

  it('generic model lists (vLLM max_model_len, gateways context_length)', async () => {
    const { f } = fakeFetch({ 'https://gw.example/v1/models': { data: [{ id: 'a', max_model_len: 40960 }, { id: 'b', context_length: 200000 }] } });
    expect(await resolveContextWindow({ kind: 'openai_compat', baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'a' }, f)).toBe(40960);
    expect(await resolveContextWindow({ kind: 'openai_compat', baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'b' }, f)).toBe(200000);
    expect(await resolveContextWindow({ kind: 'openai_compat', baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'c' }, f)).toBeNull();
  });

  it('OpenRouter and Gemini', async () => {
    const { f } = fakeFetch({
      'https://openrouter.ai/api/v1/models': { data: [{ id: 'moonshotai/kimi-k2', context_length: 131072, top_provider: { context_length: 128000 } }] },
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro': { name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576 },
    });
    expect(await resolveContextWindow({ kind: 'openrouter', baseUrl: null, apiKey: 'k', model: 'moonshotai/kimi-k2' }, f)).toBe(131072);
    expect(await resolveContextWindow({ kind: 'gemini', baseUrl: null, apiKey: 'k', model: 'gemini-2.5-pro' }, f)).toBe(1048576);
  });

  it('plain OpenAI and unreachable providers → null (the agent knows its models)', async () => {
    const { f, calls } = fakeFetch({});
    expect(await resolveContextWindow({ kind: 'openai', baseUrl: null, apiKey: 'k', model: 'gpt-5' }, f)).toBeNull();
    expect(calls).toEqual([]);
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await resolveContextWindow({ kind: 'openai_compat', baseUrl: 'http://down/v1', apiKey: '', model: 'm' }, failing)).toBeNull();
  });

  it('caches per provider + model', async () => {
    const { f, calls } = fakeFetch({ 'http://lm:1234/api/v0/models': { data: [{ id: 'm', loaded_context_length: 4096 }] } });
    const probe = { kind: 'openai_compat' as const, baseUrl: 'http://lm:1234/v1', apiKey: '', model: 'm' };
    expect(await resolveContextWindow(probe, f)).toBe(4096);
    const n = calls.length;
    expect(await resolveContextWindow(probe, f)).toBe(4096);
    expect(calls.length).toBe(n);
  });
});
