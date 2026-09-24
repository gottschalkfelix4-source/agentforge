import type { FastifyInstance } from 'fastify';
import { APP_CALL_CHATGPT_TOKEN, type AgentProfile, type ChatGptDevicePoll, type Provider, type ProviderKind, type WsdNotifications } from '@vibe/shared';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { accountOf, type ChatGptTokens } from '../chatgpt/auth.js';
import { chatgptService, LAUNCH_MIN_VALID_MS } from '../chatgpt/service.js';
import { nowIso } from '../db/index.js';
import { testChatGptProvider as testChatGpt, testProvider } from '../tools/provider-test.js';
import { HttpError } from '../workspaces/manager.js';

export interface ProviderRecord extends Provider {
  secretId: string | null;
}

interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  base_url: string | null;
  secret_id: string | null;
  models_json: string;
  default_model: string | null;
  created_at: string;
}

interface ProfileRow {
  id: string;
  agent_kind: string;
  name: string;
  auth_mode: 'subscription' | 'provider';
  provider_id: string | null;
  model: string | null;
  extra_args_json: string;
  env_json: string;
  approval_policy: AgentProfile['approvalPolicy'];
  created_at: string;
}

const toProvider = (r: ProviderRow): ProviderRecord => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  baseUrl: r.base_url,
  hasKey: !!r.secret_id,
  secretId: r.secret_id,
  models: JSON.parse(r.models_json) as string[],
  defaultModel: r.default_model,
  createdAt: r.created_at,
});

const publicProvider = ({ secretId: _s, ...p }: ProviderRecord): Provider => p;

const toProfile = (r: ProfileRow): AgentProfile => ({
  id: r.id,
  agentKind: r.agent_kind,
  name: r.name,
  authMode: r.auth_mode,
  providerId: r.provider_id,
  model: r.model,
  extraArgs: JSON.parse(r.extra_args_json) as string[],
  env: JSON.parse(r.env_json) as Record<string, string>,
  approvalPolicy: r.approval_policy ?? 'ask',
  createdAt: r.created_at,
});

const providerKind = z.enum(['anthropic', 'openai', 'openrouter', 'openai_compat', 'anthropic_compat', 'ollama', 'gemini', 'openai_chatgpt']);
const providerInput = z.object({
  kind: providerKind,
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url().nullish().or(z.literal('').transform(() => null)),
  apiKey: z.string().optional(),
  chatgptLogin: z.string().min(1).max(100).optional(),
  models: z.array(z.string().trim().min(1)).optional(),
  defaultModel: z.string().trim().nullish(),
});

const profileInput = z.object({
  agentKind: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  authMode: z.enum(['subscription', 'provider']),
  providerId: z.string().nullish(),
  model: z.string().trim().nullish(),
  extraArgs: z.array(z.string()).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  approvalPolicy: z.enum(['ask', 'edits', 'all']).optional(),
});

/** Secrets a launch needs: the API key, or for ChatGPT subscriptions tokens valid for a while. */
export interface LaunchCredentials {
  apiKey: string | null;
  chatgpt: ChatGptTokens | null;
}

export function providerRepo(ctx: AppContext) {
  return {
    get(id: string): ProviderRecord | null {
      const r = ctx.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
      return r ? toProvider(r) : null;
    },
    async credentials(p: ProviderRecord | null): Promise<LaunchCredentials> {
      if (!p) return { apiKey: null, chatgpt: null };
      if (p.kind === 'openai_chatgpt') return { apiKey: null, chatgpt: await chatgptService(ctx).tokens(p, LAUNCH_MIN_VALID_MS) };
      return { apiKey: p.secretId ? ctx.secrets.get(p.secretId) : null, chatgpt: null };
    },
    profile(id: string): AgentProfile | null {
      const r = ctx.db.get<ProfileRow>('SELECT * FROM agent_profiles WHERE id = ?', id);
      return r ? toProfile(r) : null;
    },
  };
}

export async function providerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, secrets } = ctx;
  const repo = providerRepo(ctx);
  const chatgpt = chatgptService(ctx);

  /** Public view; ChatGPT providers show their account (read from the encrypted login). */
  const toPublic = (p: ProviderRecord): Provider => {
    if (p.kind !== 'openai_chatgpt') return publicProvider(p);
    const t = chatgpt.stored(p);
    return { ...publicProvider(p), hasKey: !!t, account: t ? accountOf(t) : null };
  };

  /** Secret value to store on create/update: the API key, or the tokens of a finished ChatGPT login. */
  const secretValue = (kind: ProviderKind, body: { apiKey?: string; chatgptLogin?: string }): string | undefined => {
    if (kind !== 'openai_chatgpt') return body.apiKey;
    if (!body.chatgptLogin) return undefined;
    const t = chatgpt.auth.takeLogin(body.chatgptLogin);
    if (!t) throw new HttpError(400, 'chatgpt_login_expired', 'Die ChatGPT-Anmeldung ist abgelaufen – bitte erneut anmelden');
    return JSON.stringify(t);
  };

  app.get('/api/providers', async () =>
    db.all<ProviderRow>('SELECT * FROM providers ORDER BY created_at').map((r) => toPublic(toProvider(r))),
  );

  // ---- ChatGPT subscription login (device flow; tokens stay on the server) --------------------------

  app.post('/api/providers/chatgpt/device/start', async () => chatgpt.auth.deviceStart());

  app.post('/api/providers/chatgpt/device/poll', async (req): Promise<ChatGptDevicePoll> => {
    const { handle } = z.object({ handle: z.string().min(1).max(100) }).parse(req.body);
    return chatgpt.auth.devicePoll(handle);
  });

  // Codex in a workspace fetches the current access token through its `auth.command`
  // (agentforge-chatgpt-token → wsd /app-call → app.request). Only the access token leaves the server.
  ctx.workspaces.onWsdNotification((projectId, method, params) => {
    if (method !== 'app.request') return;
    const r = params as WsdNotifications['app.request'];
    if (r.method !== APP_CALL_CHATGPT_TOKEN) return;
    void (async (): Promise<{ result?: unknown; error?: string }> => {
      const providerId = (r.params as { providerId?: unknown } | null)?.providerId;
      const p = typeof providerId === 'string' ? repo.get(providerId) : null;
      if (!p || p.kind !== 'openai_chatgpt') return { error: 'ChatGPT-Provider nicht gefunden' };
      try {
        const t = await chatgpt.tokens(p);
        return { result: { accessToken: t.accessToken, accountId: t.accountId } };
      } catch (err) {
        return { error: (err as Error).message };
      }
    })().then((reply) => {
      try {
        void ctx.workspaces.client(projectId).call('app.respond', { id: r.id, ...reply }).catch(() => undefined);
      } catch {
        /* workspace disconnected meanwhile */
      }
    });
  });

  app.post('/api/providers', async (req) => {
    const body = providerInput.parse(req.body);
    const id = ulid();
    const value = secretValue(body.kind, body);
    const secretId = value ? secrets.create(`provider:${id}`, value) : null;
    db.insert('providers', {
      id,
      kind: body.kind,
      name: body.name,
      base_url: body.baseUrl ?? null,
      secret_id: secretId,
      models_json: JSON.stringify(body.models ?? []),
      default_model: body.defaultModel ?? null,
      created_at: nowIso(),
    });
    return toPublic(repo.get(id)!);
  });

  app.patch<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    const existing = repo.get(req.params.id);
    if (!existing) throw new HttpError(404, 'not_found', 'Provider nicht gefunden');
    const body = providerInput.partial().parse(req.body);
    const kind = body.kind ?? existing.kind;
    let secretId = existing.secretId;
    // Switching between API key and ChatGPT login drops the old secret (a key is no login and vice versa).
    const kindSwitch = (kind === 'openai_chatgpt') !== (existing.kind === 'openai_chatgpt');
    const value = secretValue(kind, body) ?? (kindSwitch ? '' : undefined);
    if (value !== undefined) {
      if (value === '') {
        if (secretId) secrets.delete(secretId);
        secretId = null;
      } else if (secretId) secrets.replace(secretId, value);
      else secretId = secrets.create(`provider:${existing.id}`, value);
    }
    db.update('providers', existing.id, {
      kind: body.kind,
      name: body.name,
      base_url: body.baseUrl === undefined ? undefined : body.baseUrl,
      secret_id: secretId,
      models_json: body.models ? JSON.stringify(body.models) : undefined,
      default_model: body.defaultModel === undefined ? undefined : body.defaultModel,
    });
    return toPublic(repo.get(existing.id)!);
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    const existing = repo.get(req.params.id);
    if (!existing) throw new HttpError(404, 'not_found', 'Provider nicht gefunden');
    db.tx(() => {
      db.run('DELETE FROM providers WHERE id = ?', existing.id);
      if (existing.secretId) secrets.delete(existing.secretId);
    });
    return { ok: true };
  });

  // Phase 6: connectivity test = list the provider's models (10 s timeout).
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (req) => {
    const existing = repo.get(req.params.id);
    if (!existing) throw new HttpError(404, 'not_found', 'Provider nicht gefunden');
    // Optional overrides let the edit dialog test unsaved changes against the stored key.
    const body = z
      .object({ kind: providerKind.optional(), baseUrl: z.string().trim().nullish(), apiKey: z.string().optional(), chatgptLogin: z.string().max(100).optional() })
      .parse(req.body ?? {});
    if ((body.kind ?? existing.kind) === 'openai_chatgpt') {
      if (body.chatgptLogin) return testChatGpt(chatgpt.auth.peekLogin(body.chatgptLogin));
      if (existing.kind !== 'openai_chatgpt') return testChatGpt(null);
      try {
        return testChatGpt(await chatgpt.tokens(existing));
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    const apiKey = body.apiKey || (existing.secretId ? (secrets.get(existing.secretId) ?? '') : '');
    return testProvider({ kind: body.kind ?? existing.kind, baseUrl: body.baseUrl === undefined ? existing.baseUrl : body.baseUrl || null, apiKey });
  });

  app.post('/api/providers/test', async (req) => {
    const body = providerInput.pick({ kind: true, baseUrl: true, apiKey: true, chatgptLogin: true }).parse(req.body);
    if (body.kind === 'openai_chatgpt') return testChatGpt(body.chatgptLogin ? chatgpt.auth.peekLogin(body.chatgptLogin) : null);
    return testProvider({ kind: body.kind, baseUrl: body.baseUrl ?? null, apiKey: body.apiKey ?? '' });
  });

  app.get('/api/agent-profiles', async () =>
    db.all<ProfileRow>('SELECT * FROM agent_profiles ORDER BY created_at').map(toProfile),
  );

  app.post('/api/agent-profiles', async (req) => {
    const body = profileInput.parse(req.body);
    if (body.providerId && !repo.get(body.providerId)) throw new HttpError(400, 'invalid_provider', 'Provider existiert nicht');
    const id = ulid();
    db.insert('agent_profiles', {
      id,
      agent_kind: body.agentKind,
      name: body.name,
      auth_mode: body.authMode,
      provider_id: body.providerId ?? null,
      model: body.model || null,
      extra_args_json: JSON.stringify(body.extraArgs ?? []),
      env_json: JSON.stringify(body.env ?? {}),
      approval_policy: body.approvalPolicy ?? 'ask',
      created_at: nowIso(),
    });
    return repo.profile(id);
  });

  app.patch<{ Params: { id: string } }>('/api/agent-profiles/:id', async (req) => {
    if (!repo.profile(req.params.id)) throw new HttpError(404, 'not_found', 'Profil nicht gefunden');
    const body = profileInput.partial().parse(req.body);
    db.update('agent_profiles', req.params.id, {
      agent_kind: body.agentKind,
      name: body.name,
      auth_mode: body.authMode,
      provider_id: body.providerId === undefined ? undefined : body.providerId,
      model: body.model === undefined ? undefined : body.model || null,
      extra_args_json: body.extraArgs ? JSON.stringify(body.extraArgs) : undefined,
      env_json: body.env ? JSON.stringify(body.env) : undefined,
      approval_policy: body.approvalPolicy,
    });
    return repo.profile(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/agent-profiles/:id', async (req) => {
    db.run('DELETE FROM agent_profiles WHERE id = ?', req.params.id);
    return { ok: true };
  });
}
