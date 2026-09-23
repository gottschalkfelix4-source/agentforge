// Per-agent provider renderers: turn a provider (+ key + model) into env/args for one agent CLI.
// Secrets only ever go into env. Behaviour and limitations: docs/api.md, section "Provider-Renderer".

import {
  anthropicRoot,
  empty,
  keyOr,
  ollamaRoot,
  openaiBase,
  prefixed,
  type ProviderRender,
  type ProviderRenderer,
} from './common.js';

const isOpenAiLike = (k: string) => k === 'openai' || k === 'openai_compat' || k === 'openrouter' || k === 'ollama';
const isAnthropicLike = (k: string) => k === 'anthropic' || k === 'anthropic_compat';

// ---- Claude Code ------------------------------------------------------------------------------

export const renderClaude: ProviderRenderer = ({ provider: p, apiKey, model }) => {
  const r = empty();
  switch (p.kind) {
    case 'anthropic':
      r.env.ANTHROPIC_API_KEY = apiKey;
      if (p.baseUrl) r.env.ANTHROPIC_BASE_URL = anthropicRoot(p);
      break;
    case 'anthropic_compat':
    case 'openrouter':
      r.env.ANTHROPIC_BASE_URL = anthropicRoot(p);
      r.env.ANTHROPIC_AUTH_TOKEN = apiKey;
      r.env.ANTHROPIC_API_KEY = '';
      break;
    case 'ollama':
      // Ollama ≥ 0.14 serves the Anthropic Messages API at its root URL.
      r.env.ANTHROPIC_BASE_URL = ollamaRoot(p);
      r.env.ANTHROPIC_AUTH_TOKEN = keyOr(apiKey, 'ollama');
      r.env.ANTHROPIC_API_KEY = '';
      // Background/sub-agent requests would otherwise ask for Claude model names Ollama does not have.
      if (model) {
        r.env.ANTHROPIC_MODEL = model;
        r.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
        r.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      }
      break;
  }
  return r;
};

// ---- Codex ------------------------------------------------------------------------------------

export const renderCodex: ProviderRenderer = ({ provider: p, apiKey }) => {
  const r = empty();
  if (p.kind === 'openai' && !p.baseUrl) {
    r.env.OPENAI_API_KEY = apiKey;
    return r;
  }
  // Custom provider via config overrides; the user's config.toml stays untouched. Codex ≥ 0.1xx only speaks
  // the Responses API (`wire_api = "chat"` was removed) — Ollama ≥ 0.13 and OpenRouter serve /v1/responses.
  r.env.VIBE_PROVIDER_KEY = keyOr(apiKey);
  const args = [
    '-c', `model_provider="vibe"`,
    '-c', `model_providers.vibe.name=${JSON.stringify(p.name)}`,
    '-c', `model_providers.vibe.base_url=${JSON.stringify(openaiBase(p))}`,
    '-c', `model_providers.vibe.env_key="VIBE_PROVIDER_KEY"`,
    '-c', `model_providers.vibe.wire_api="responses"`,
  ];
  r.args = args;
  r.structuredArgs = [...args];
  return r;
};

// ---- OpenCode / Kilo (same config schema) -----------------------------------------------------

const NATIVE_OPENCODE: Partial<Record<string, string>> = { anthropic: 'anthropic', openai: 'openai', gemini: 'google' };
const KEY_REF = '{env:VIBE_PROVIDER_KEY}';

/** Inline config (OPENCODE_CONFIG_CONTENT / KILO_CONFIG_CONTENT); the key is referenced, never embedded. */
export function openCodeConfig(input: Parameters<ProviderRenderer>[0]): { config: Record<string, unknown>; model: string | null } {
  const { provider: p, model } = input;
  const native = NATIVE_OPENCODE[p.kind];
  let providerId: string;
  let providerCfg: Record<string, unknown>;
  if (native) {
    providerId = native;
    const options: Record<string, unknown> = { apiKey: KEY_REF };
    if (p.baseUrl) options.baseURL = native === 'anthropic' ? `${anthropicRoot(p)}/v1` : p.baseUrl.replace(/\/+$/, '');
    providerCfg = { options };
  } else {
    providerId = 'vibe';
    const models = [...new Set([...(p.models ?? []), ...(p.defaultModel ? [p.defaultModel] : []), ...(model ? [model] : [])])];
    const anthropic = p.kind === 'anthropic_compat';
    providerCfg = {
      npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
      name: p.name,
      options: { baseURL: anthropic ? `${anthropicRoot(p)}/v1` : openaiBase(p), apiKey: KEY_REF },
      models: Object.fromEntries(models.map((m) => [m, { name: m }])),
    };
  }
  const fullModel = model ? `${providerId}/${model}` : null;
  const config: Record<string, unknown> = { provider: { [providerId]: providerCfg } };
  if (fullModel) config.model = fullModel;
  return { config, model: fullModel };
}

const openCodeLike =
  (envVar: string): ProviderRenderer =>
  (input) => {
    const r = empty();
    const { config, model } = openCodeConfig(input);
    r.env[envVar] = JSON.stringify(config);
    r.env.VIBE_PROVIDER_KEY = keyOr(input.apiKey);
    r.model = model;
    return r;
  };

export const renderOpenCode = openCodeLike('OPENCODE_CONFIG_CONTENT');
export const renderKilo = openCodeLike('KILO_CONFIG_CONTENT');

// ---- Gemini CLI -------------------------------------------------------------------------------

export const renderGemini: ProviderRenderer = ({ provider: p, apiKey }) => {
  const r = empty();
  if (p.kind !== 'gemini') return r;
  r.env.GEMINI_API_KEY = apiKey;
  r.env.GEMINI_DEFAULT_AUTH_TYPE = 'gemini-api-key';
  if (p.baseUrl) r.env.GOOGLE_GEMINI_BASE_URL = p.baseUrl;
  return r;
};

// ---- Qwen Code --------------------------------------------------------------------------------

export const renderQwen: ProviderRenderer = ({ provider: p, apiKey, model }) => {
  const r = empty();
  let authType: string;
  if (isOpenAiLike(p.kind)) {
    authType = 'openai';
    r.env.OPENAI_API_KEY = keyOr(apiKey, 'ollama');
    r.env.OPENAI_BASE_URL = openaiBase(p);
    if (model) r.env.OPENAI_MODEL = model;
  } else if (isAnthropicLike(p.kind)) {
    authType = 'anthropic';
    r.env.ANTHROPIC_API_KEY = apiKey;
    r.env.ANTHROPIC_BASE_URL = anthropicRoot(p);
    if (model) r.env.ANTHROPIC_MODEL = model;
  } else if (p.kind === 'gemini') {
    authType = 'gemini';
    r.env.GEMINI_API_KEY = apiKey;
    if (model) r.env.GEMINI_MODEL = model;
  } else {
    return r;
  }
  // The env default only applies without a stored choice; the flag wins over ~/.qwen/settings.json.
  r.env.QWEN_DEFAULT_AUTH_TYPE = authType;
  r.args = ['--auth-type', authType];
  r.structuredArgs = ['--auth-type', authType];
  // The env picks the model; Qwen's ACP model ids look like `$runtime|openai|<model>(openai)`.
  r.structuredModel = null;
  return r;
};

// ---- GitHub Copilot CLI (BYOK) ----------------------------------------------------------------

export const renderCopilot: ProviderRenderer = ({ provider: p, apiKey, model }) => {
  const r = empty();
  if (isOpenAiLike(p.kind)) {
    r.env.COPILOT_PROVIDER_TYPE = 'openai';
    r.env.COPILOT_PROVIDER_BASE_URL = openaiBase(p);
    // GPT-5 class models on api.openai.com need the Responses API.
    if (p.kind === 'openai') r.env.COPILOT_PROVIDER_WIRE_API = 'responses';
  } else if (isAnthropicLike(p.kind)) {
    r.env.COPILOT_PROVIDER_TYPE = 'anthropic';
    r.env.COPILOT_PROVIDER_BASE_URL = anthropicRoot(p);
  } else {
    return r;
  }
  if (apiKey) r.env.COPILOT_PROVIDER_API_KEY = apiKey;
  if (model) r.env.COPILOT_MODEL = model;
  // BYOK: COPILOT_MODEL selects the model; the ACP side lists no models to switch to.
  r.structuredModel = null;
  return r;
};

// ---- Cline ------------------------------------------------------------------------------------

const CLINE_PROVIDER: Record<string, string> = {
  anthropic: 'anthropic',
  anthropic_compat: 'anthropic',
  openai: 'openai-native',
  openai_compat: 'openai-compatible',
  openrouter: 'openrouter',
  ollama: 'ollama',
  gemini: 'gemini',
};

/**
 * Best effort: Cline reads provider + model from CLINE_PROVIDER / CLINE_MODEL and keys from the providers'
 * standard env vars. Custom base URLs (OpenAI-compatible, Ollama) are only honoured where the SDK reads
 * the env var; otherwise run `cline auth -p <provider> -b <url>` once in the login terminal.
 */
export const renderCline: ProviderRenderer = ({ provider: p, apiKey, model }) => {
  const r = empty();
  const id = CLINE_PROVIDER[p.kind];
  if (!id) return r;
  r.env.CLINE_PROVIDER = id;
  if (model) r.env.CLINE_MODEL = model;
  switch (p.kind) {
    case 'anthropic':
      r.env.ANTHROPIC_API_KEY = apiKey;
      break;
    case 'anthropic_compat':
      r.env.ANTHROPIC_API_KEY = apiKey;
      r.env.ANTHROPIC_BASE_URL = anthropicRoot(p);
      break;
    case 'openai':
      r.env.OPENAI_API_KEY = apiKey;
      if (p.baseUrl) r.env.OPENAI_BASE_URL = openaiBase(p);
      break;
    case 'openai_compat':
      r.env.OPENAI_API_KEY = keyOr(apiKey);
      r.env.OPENAI_BASE_URL = openaiBase(p);
      break;
    case 'openrouter':
      r.env.OPENROUTER_API_KEY = apiKey;
      break;
    case 'ollama':
      r.env.OLLAMA_HOST = ollamaRoot(p);
      if (apiKey) r.env.OLLAMA_API_KEY = apiKey;
      break;
    case 'gemini':
      r.env.GEMINI_API_KEY = apiKey;
      break;
  }
  // The TUI prefers the last used provider over the env; the flag makes the profile win.
  r.args = ['--provider', id];
  return r;
};

// ---- Aider (litellm) --------------------------------------------------------------------------

export const renderAider: ProviderRenderer = ({ provider: p, apiKey, model }) => {
  const r = empty();
  switch (p.kind) {
    case 'anthropic':
      r.env.ANTHROPIC_API_KEY = apiKey;
      break;
    case 'anthropic_compat':
      r.env.ANTHROPIC_API_KEY = apiKey;
      r.env.ANTHROPIC_API_BASE = anthropicRoot(p);
      r.model = prefixed('anthropic', model);
      break;
    case 'openai':
      r.env.OPENAI_API_KEY = apiKey;
      if (p.baseUrl) r.env.OPENAI_API_BASE = openaiBase(p);
      break;
    case 'openai_compat':
      r.env.OPENAI_API_KEY = keyOr(apiKey);
      r.env.OPENAI_API_BASE = openaiBase(p);
      r.model = prefixed('openai', model);
      break;
    case 'openrouter':
      r.env.OPENROUTER_API_KEY = apiKey;
      r.model = prefixed('openrouter', model);
      break;
    case 'ollama':
      r.env.OLLAMA_API_BASE = ollamaRoot(p);
      r.model = prefixed('ollama_chat', model);
      break;
    case 'gemini':
      r.env.GEMINI_API_KEY = apiKey;
      r.model = prefixed('gemini', model);
      break;
  }
  return r;
};

// ---- Goose ------------------------------------------------------------------------------------

export const renderGoose: ProviderRenderer = ({ provider: p, apiKey, model }) => {
  const r = empty();
  switch (p.kind) {
    case 'anthropic':
    case 'anthropic_compat':
      r.env.GOOSE_PROVIDER = 'anthropic';
      r.env.ANTHROPIC_API_KEY = apiKey;
      if (p.baseUrl) r.env.ANTHROPIC_HOST = anthropicRoot(p);
      break;
    case 'openai':
    case 'openai_compat': {
      r.env.GOOSE_PROVIDER = 'openai';
      r.env.OPENAI_API_KEY = keyOr(apiKey);
      if (p.baseUrl) {
        const u = new URL(openaiBase(p));
        r.env.OPENAI_HOST = u.origin;
        r.env.OPENAI_BASE_PATH = `${u.pathname.replace(/^\/+|\/+$/g, '')}/chat/completions`.replace(/^\//, '');
      }
      break;
    }
    case 'openrouter':
      r.env.GOOSE_PROVIDER = 'openrouter';
      r.env.OPENROUTER_API_KEY = apiKey;
      if (p.baseUrl) r.env.OPENROUTER_HOST = new URL(p.baseUrl).origin;
      break;
    case 'ollama':
      r.env.GOOSE_PROVIDER = 'ollama';
      r.env.OLLAMA_HOST = ollamaRoot(p);
      break;
    case 'gemini':
      r.env.GOOSE_PROVIDER = 'google';
      r.env.GOOGLE_API_KEY = apiKey;
      break;
  }
  // Goose has no model flag; GOOSE_MODEL is required together with GOOSE_PROVIDER.
  if (model && r.env.GOOSE_PROVIDER) r.env.GOOSE_MODEL = model;
  return r;
};

// ---- Fallback for agents without a dedicated renderer ----------------------------------------

export const renderGeneric: ProviderRenderer = ({ provider: p, apiKey }) => {
  const r: ProviderRender = empty();
  switch (p.kind) {
    case 'anthropic':
    case 'anthropic_compat':
      r.env.ANTHROPIC_API_KEY = apiKey;
      if (p.baseUrl) r.env.ANTHROPIC_BASE_URL = anthropicRoot(p);
      break;
    case 'openai':
    case 'openai_compat':
      r.env.OPENAI_API_KEY = keyOr(apiKey);
      if (p.baseUrl) r.env.OPENAI_BASE_URL = openaiBase(p);
      break;
    case 'openrouter':
      r.env.OPENROUTER_API_KEY = apiKey;
      break;
    case 'ollama':
      r.env.OLLAMA_HOST = ollamaRoot(p);
      break;
    case 'gemini':
      r.env.GEMINI_API_KEY = apiKey;
      break;
  }
  return r;
};

export const RENDERERS: Record<string, ProviderRenderer> = {
  claude: renderClaude,
  codex: renderCodex,
  opencode: renderOpenCode,
  kilo: renderKilo,
  gemini: renderGemini,
  qwen: renderQwen,
  copilot: renderCopilot,
  cline: renderCline,
  aider: renderAider,
  goose: renderGoose,
};

export function renderProvider(agentId: string, input: Parameters<ProviderRenderer>[0]): ProviderRender {
  return (RENDERERS[agentId] ?? renderGeneric)(input);
}
