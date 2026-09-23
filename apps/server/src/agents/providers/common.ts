import type { ProviderRecord } from '../../routes/providers.js';

/** Input of a provider renderer: the resolved provider, its decrypted key and the effective model. */
export interface RenderInput {
  provider: ProviderRecord;
  apiKey: string;
  model: string | null;
}

/**
 * What a renderer contributes to a launch. Secrets only ever go into `env` (process env of the agent),
 * never into args or files.
 */
export interface ProviderRender {
  env: Record<string, string>;
  /** Extra args for the TUI (prepended before the model flag). */
  args: string[];
  /** Extra args for the structured interface (ACP / app-server). */
  structuredArgs: string[];
  /** Rewritten model id (e.g. `vibe/<model>` for OpenCode); undefined = unchanged. */
  model?: string | null;
  /** Model for the structured launch if it differs (null = the env already selects it; ACP ids differ). */
  structuredModel?: string | null;
}

export type ProviderRenderer = (input: RenderInput) => ProviderRender;

export const empty = (): ProviderRender => ({ env: {}, args: [], structuredArgs: [] });

export const OPENAI_BASE = 'https://api.openai.com/v1';
export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const OPENROUTER_OPENAI = 'https://openrouter.ai/api/v1';
export const OPENROUTER_ANTHROPIC = 'https://openrouter.ai/api';
export const OLLAMA_DEFAULT = 'http://host.docker.internal:11434';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Ollama root URL (without `/v1` or `/api`). */
export function ollamaRoot(p: ProviderRecord): string {
  return trimSlash(p.baseUrl || OLLAMA_DEFAULT).replace(/\/(v1|api)$/, '');
}

/** OpenAI-style base URL ending in `/v1` (or whatever path the user configured). */
export function openaiBase(p: ProviderRecord): string {
  switch (p.kind) {
    case 'ollama':
      return `${ollamaRoot(p)}/v1`;
    case 'openrouter':
      return trimSlash(p.baseUrl || OPENROUTER_OPENAI);
    default:
      return trimSlash(p.baseUrl || OPENAI_BASE);
  }
}

/** Anthropic-style base URL without the `/v1` suffix (what ANTHROPIC_BASE_URL expects). */
export function anthropicRoot(p: ProviderRecord): string {
  if (p.kind === 'openrouter') return trimSlash(p.baseUrl || OPENROUTER_ANTHROPIC).replace(/\/v1$/, '');
  if (p.kind === 'ollama') return ollamaRoot(p);
  return trimSlash(p.baseUrl || ANTHROPIC_BASE).replace(/\/v1$/, '');
}

/** Placeholder for keyless endpoints (Ollama) — many SDKs refuse an empty key. */
export const keyOr = (key: string, fallback = 'none') => key || fallback;

/** Adds `prefix/` unless the model already starts with it. */
export const prefixed = (prefix: string, model: string | null) =>
  model ? (model.startsWith(`${prefix}/`) ? model : `${prefix}/${model}`) : model;
