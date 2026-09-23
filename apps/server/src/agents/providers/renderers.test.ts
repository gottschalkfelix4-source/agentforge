import { describe, expect, it } from 'vitest';
import { AGENT_MANIFESTS, type AgentProfile, type ProviderKind } from '@vibe/shared';
import type { ProviderRecord } from '../../routes/providers.js';
import { buildAgentLaunch, buildStructuredLaunch } from '../launch.js';
import { renderProvider } from './renderers.js';

const KEY = 'sk-super-secret-123';

const provider = (kind: ProviderKind, p: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: 'prov',
  kind,
  name: 'Prov',
  baseUrl: null,
  hasKey: true,
  secretId: 's',
  models: [],
  defaultModel: null,
  createdAt: '',
  ...p,
});

const profile = (agentKind: string, p: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'pf',
  agentKind,
  name: 'Test',
  authMode: 'provider',
  providerId: 'prov',
  model: 'm1',
  extraArgs: [],
  env: {},
  createdAt: '',
  ...p,
});

const render = (agent: string, kind: ProviderKind, p: Partial<ProviderRecord> = {}, model: string | null = 'm1') =>
  renderProvider(agent, { provider: provider(kind, p), apiKey: KEY, model });

describe('provider renderers: no secrets in args', () => {
  for (const m of AGENT_MANIFESTS) {
    for (const kind of m.providerKinds) {
      it(`${m.id} × ${kind}`, () => {
        const ctx = { profile: profile(m.id), provider: provider(kind, { baseUrl: kind.endsWith('compat') ? 'https://x.example/v1' : null }), apiKey: KEY };
        const tui = buildAgentLaunch(m.id, 'run', ctx);
        expect(JSON.stringify(tui.args)).not.toContain(KEY);
        if (kind !== 'ollama') expect(JSON.stringify(tui.env)).toContain(KEY);
        if (m.structured) {
          const s = buildStructuredLaunch(m.id, ctx);
          expect(JSON.stringify(s.args)).not.toContain(KEY);
          if (kind !== 'ollama') expect(JSON.stringify(s.env)).toContain(KEY);
        }
      });
    }
  }

  it('rejects provider kinds an agent does not support', () => {
    expect(() => buildAgentLaunch('gemini', 'run', { profile: profile('gemini'), provider: provider('openai'), apiKey: KEY })).toThrow(/unterstützt/);
  });
});

describe('claude', () => {
  it('openrouter → Anthropic-compatible endpoint with auth token', () => {
    const r = render('claude', 'openrouter');
    expect(r.env).toEqual({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: '' });
  });
  it('ollama → ANTHROPIC_BASE_URL at the Ollama root and all default models mapped', () => {
    const r = render('claude', 'ollama', { baseUrl: 'http://host.docker.internal:11434/v1' }, 'qwen3-coder');
    expect(r.env.ANTHROPIC_BASE_URL).toBe('http://host.docker.internal:11434');
    expect(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3-coder');
  });
});

describe('codex', () => {
  it('ollama → custom provider on /v1 with the responses wire API', () => {
    const r = render('codex', 'ollama');
    expect(r.args).toContain('model_providers.vibe.base_url="http://host.docker.internal:11434/v1"');
    expect(r.args).toContain('model_providers.vibe.wire_api="responses"');
    expect(r.structuredArgs).toEqual(r.args);
    expect(r.env.VIBE_PROVIDER_KEY).toBe(KEY);
  });
  it('plain OpenAI only sets OPENAI_API_KEY', () => {
    expect(render('codex', 'openai')).toMatchObject({ env: { OPENAI_API_KEY: KEY }, args: [] });
  });
});

describe('opencode / kilo', () => {
  it('openai_compat → inline config with openai-compatible provider and key reference', () => {
    const r = render('opencode', 'openai_compat', { baseUrl: 'http://litellm:4000/v1/', models: ['a', 'b'] }, 'b');
    const cfg = JSON.parse(r.env.OPENCODE_CONFIG_CONTENT!);
    expect(cfg.model).toBe('vibe/b');
    expect(cfg.provider.vibe).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://litellm:4000/v1', apiKey: '{env:VIBE_PROVIDER_KEY}' },
      models: { a: { name: 'a' }, b: { name: 'b' } },
    });
    expect(r.env.OPENCODE_CONFIG_CONTENT).not.toContain(KEY);
    expect(r.env.VIBE_PROVIDER_KEY).toBe(KEY);
    expect(r.model).toBe('vibe/b');
  });
  it('anthropic → native provider; kilo uses KILO_CONFIG_CONTENT', () => {
    const r = render('kilo', 'anthropic', {}, 'claude-sonnet-4-5');
    const cfg = JSON.parse(r.env.KILO_CONFIG_CONTENT!);
    expect(cfg.provider.anthropic.options.apiKey).toBe('{env:VIBE_PROVIDER_KEY}');
    expect(r.model).toBe('anthropic/claude-sonnet-4-5');
    expect(r.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
  it('ollama → /v1 base, anthropic_compat → @ai-sdk/anthropic with /v1', () => {
    expect(JSON.parse(render('opencode', 'ollama').env.OPENCODE_CONFIG_CONTENT!).provider.vibe.options.baseURL).toBe('http://host.docker.internal:11434/v1');
    const a = JSON.parse(render('opencode', 'anthropic_compat', { baseUrl: 'https://proxy.example' }).env.OPENCODE_CONFIG_CONTENT!);
    expect(a.provider.vibe).toMatchObject({ npm: '@ai-sdk/anthropic', options: { baseURL: 'https://proxy.example/v1' } });
  });
  it('TUI passes the prefixed model via --model', () => {
    const l = buildAgentLaunch('opencode', 'run', { profile: profile('opencode'), provider: provider('openrouter'), apiKey: KEY });
    expect(l.args).toEqual(['--model', 'vibe/m1']);
    const s = buildStructuredLaunch('opencode', { profile: profile('opencode'), provider: provider('openrouter'), apiKey: KEY });
    expect(s).toMatchObject({ args: ['acp'], model: 'vibe/m1' });
  });
});

describe('gemini / qwen / copilot / cline / aider / goose', () => {
  it('gemini → GEMINI_API_KEY + default auth type', () => {
    expect(render('gemini', 'gemini').env).toEqual({ GEMINI_API_KEY: KEY, GEMINI_DEFAULT_AUTH_TYPE: 'gemini-api-key' });
  });
  it('qwen → OpenAI env + --auth-type for TUI and ACP', () => {
    const r = render('qwen', 'ollama', {}, 'qwen3-coder');
    expect(r.env).toMatchObject({ OPENAI_BASE_URL: 'http://host.docker.internal:11434/v1', OPENAI_MODEL: 'qwen3-coder', QWEN_DEFAULT_AUTH_TYPE: 'openai' });
    const s = buildStructuredLaunch('qwen', { profile: profile('qwen'), provider: provider('anthropic'), apiKey: KEY });
    expect(s.args).toEqual(['--acp', '--auth-type', 'anthropic']);
    expect(s.model).toBeNull(); // env selects it; ACP ids differ
    expect(s.env).toMatchObject({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_MODEL: 'm1' });
  });
  it('copilot → BYOK env', () => {
    expect(render('copilot', 'openai').env).toEqual({
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
      COPILOT_PROVIDER_WIRE_API: 'responses',
      COPILOT_PROVIDER_API_KEY: KEY,
      COPILOT_MODEL: 'm1',
    });
    const o = renderProvider('copilot', { provider: provider('ollama'), apiKey: '', model: 'llama' });
    expect(o.env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
    expect(o.env.COPILOT_PROVIDER_BASE_URL).toBe('http://host.docker.internal:11434/v1');
  });
  it('cline → CLINE_PROVIDER/CLINE_MODEL, --provider only for the TUI', () => {
    const r = render('cline', 'openai_compat', { baseUrl: 'http://x/v1' });
    expect(r.env).toMatchObject({ CLINE_PROVIDER: 'openai-compatible', CLINE_MODEL: 'm1', OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'http://x/v1' });
    expect(r.args).toEqual(['--provider', 'openai-compatible']);
    expect(r.structuredArgs).toEqual([]);
  });
  it('aider → litellm prefixes', () => {
    expect(render('aider', 'openrouter', {}, 'anthropic/claude-sonnet-4').model).toBe('openrouter/anthropic/claude-sonnet-4');
    expect(render('aider', 'ollama', {}, 'qwen3').model).toBe('ollama_chat/qwen3');
    expect(render('aider', 'openai_compat', { baseUrl: 'http://x/v1' }, 'openai/foo').model).toBe('openai/foo');
    const l = buildAgentLaunch('aider', 'run', { profile: profile('aider', { model: 'gemini-2.5-pro' }), provider: provider('gemini'), apiKey: KEY });
    expect(l).toMatchObject({ command: 'aider', args: ['--model', 'gemini/gemini-2.5-pro'], env: { GEMINI_API_KEY: KEY } });
  });
  it('goose → GOOSE_PROVIDER/GOOSE_MODEL, OpenAI host split', () => {
    const r = render('goose', 'openai_compat', { baseUrl: 'http://litellm:4000/v1' });
    expect(r.env).toMatchObject({ GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'm1', OPENAI_HOST: 'http://litellm:4000', OPENAI_BASE_PATH: 'v1/chat/completions' });
    const l = buildAgentLaunch('goose', 'run', { profile: profile('goose'), provider: provider('ollama'), apiKey: '' });
    expect(l.args).toEqual(['session']);
    expect(l.env).toMatchObject({ GOOSE_PROVIDER: 'ollama', OLLAMA_HOST: 'http://host.docker.internal:11434', GOOSE_DISABLE_KEYRING: '1' });
  });
});
