import { getAgentManifest, type AgentManifest, type AgentProfile, type StructuredTransport, type TermCreateParams } from '@vibe/shared';
import type { ProviderRecord } from '../routes/providers.js';
import { HttpError } from '../workspaces/manager.js';
import { empty, type ProviderRender } from './providers/common.js';
import { renderProvider } from './providers/renderers.js';

export interface LaunchContext {
  profile: AgentProfile | null;
  provider: ProviderRecord | null;
  /** Decrypted API key of the provider, if any. */
  apiKey: string | null;
  /** openai_chatgpt: current subscription tokens (see ChatGptService.tokens). */
  chatgpt?: { accessToken: string; accountId: string; expiresAt: number } | null;
  /** Provider model chosen for this launch (chat model picker); overrides profile/provider defaults. */
  modelOverride?: string | null;
}

interface Resolved {
  render: ProviderRender;
  model: string | null;
  structuredModel: string | null;
}

/** Provider env/args + effective model for a profile. Subscription mode ignores the provider. */
function resolve(m: AgentManifest, ctx: LaunchContext): Resolved {
  const profile = ctx.profile;
  const p = ctx.provider;
  if (profile?.authMode !== 'provider' || !p) {
    const model = profile?.model ?? null;
    return { render: empty(), model, structuredModel: model };
  }
  if (!m.providerKinds.includes(p.kind)) {
    throw new HttpError(400, 'invalid_profile', `${m.label} unterstützt Provider vom Typ „${p.kind}“ nicht`);
  }
  const model = ctx.modelOverride || profile.model || p.defaultModel || null;
  const chatgpt = ctx.chatgpt ? { accessToken: ctx.chatgpt.accessToken, accountId: ctx.chatgpt.accountId, expiresAt: ctx.chatgpt.expiresAt } : null;
  const render = renderProvider(m.id, { provider: p, apiKey: ctx.apiKey ?? '', model, chatgpt });
  const effective = render.model !== undefined ? render.model : model;
  return { render, model: effective, structuredModel: render.structuredModel !== undefined ? render.structuredModel : effective };
}

export interface StructuredLaunch {
  transport: StructuredTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  model: string | null;
}

/**
 * Spawn parameters for the structured (machine) interface of an agent (Phase 2 chat sessions).
 * Same provider/env resolution as the TUI; the profile's `extraArgs` are TUI flags and are not used.
 */
export function buildStructuredLaunch(agentId: string, ctx: LaunchContext): StructuredLaunch {
  const m = getAgentManifest(agentId);
  if (!m) throw new Error(`Unbekannter Agent: ${agentId}`);
  if (!m.structured) throw new Error(`${m.label} unterstützt keine Chat-Sitzungen`);
  const { render, structuredModel } = resolve(m, ctx);
  const [command, ...args] = [...(render.wrap ?? []), m.structured.command, ...m.structured.args, ...render.structuredArgs];
  return {
    transport: m.structured.transport,
    command: command!,
    args,
    env: { ...m.baseEnv, ...render.env, ...(ctx.profile?.env ?? {}) },
    model: structuredModel,
  };
}

/** Builds the PTY spawn parameters for running an agent TUI or its login flow. */
export function buildAgentLaunch(agentId: string, mode: 'run' | 'login', ctx: LaunchContext): TermCreateParams {
  const m = getAgentManifest(agentId);
  if (!m) throw new Error(`Unbekannter Agent: ${agentId}`);

  if (mode === 'login') {
    const [command, ...args] = m.loginCommand ?? [m.bin];
    return { command, args, env: { ...m.baseEnv }, title: `${m.label} – Anmeldung` };
  }

  const profile = ctx.profile;
  const { render, model } = resolve(m, ctx);
  const args = [...m.ptyArgs, ...render.args];
  if (model && m.modelFlag) args.push(m.modelFlag, model);
  args.push(...(profile?.extraArgs ?? []));
  const [command, ...wrapArgs] = [...(render.wrap ?? []), m.bin];

  return {
    command: command!,
    args: [...wrapArgs, ...args],
    env: { ...m.baseEnv, ...render.env, ...(profile?.env ?? {}) },
    title: profile ? `${m.label} (${profile.name})` : m.label,
  };
}
