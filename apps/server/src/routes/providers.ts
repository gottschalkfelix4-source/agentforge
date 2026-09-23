import type { FastifyInstance } from 'fastify';
import type { AgentProfile, Provider, ProviderKind } from '@vibe/shared';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { nowIso } from '../db/index.js';
import { testProvider } from '../tools/provider-test.js';
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
  createdAt: r.created_at,
});

const providerKind = z.enum(['anthropic', 'openai', 'openrouter', 'openai_compat', 'anthropic_compat', 'ollama', 'gemini']);
const providerInput = z.object({
  kind: providerKind,
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url().nullish().or(z.literal('').transform(() => null)),
  apiKey: z.string().optional(),
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
});

export function providerRepo(ctx: AppContext) {
  return {
    get(id: string): ProviderRecord | null {
      const r = ctx.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
      return r ? toProvider(r) : null;
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

  app.get('/api/providers', async () =>
    db.all<ProviderRow>('SELECT * FROM providers ORDER BY created_at').map((r) => publicProvider(toProvider(r))),
  );

  app.post('/api/providers', async (req) => {
    const body = providerInput.parse(req.body);
    const id = ulid();
    const secretId = body.apiKey ? secrets.create(`provider:${id}`, body.apiKey) : null;
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
    return publicProvider(repo.get(id)!);
  });

  app.patch<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    const existing = repo.get(req.params.id);
    if (!existing) throw new HttpError(404, 'not_found', 'Provider nicht gefunden');
    const body = providerInput.partial().parse(req.body);
    let secretId = existing.secretId;
    if (body.apiKey !== undefined) {
      if (body.apiKey === '') {
        if (secretId) secrets.delete(secretId);
        secretId = null;
      } else if (secretId) secrets.replace(secretId, body.apiKey);
      else secretId = secrets.create(`provider:${existing.id}`, body.apiKey);
    }
    db.update('providers', existing.id, {
      kind: body.kind,
      name: body.name,
      base_url: body.baseUrl === undefined ? undefined : body.baseUrl,
      secret_id: secretId,
      models_json: body.models ? JSON.stringify(body.models) : undefined,
      default_model: body.defaultModel === undefined ? undefined : body.defaultModel,
    });
    return publicProvider(repo.get(existing.id)!);
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
    const body = z.object({ kind: providerKind.optional(), baseUrl: z.string().trim().nullish(), apiKey: z.string().optional() }).parse(req.body ?? {});
    const apiKey = body.apiKey || (existing.secretId ? (secrets.get(existing.secretId) ?? '') : '');
    return testProvider({ kind: body.kind ?? existing.kind, baseUrl: body.baseUrl === undefined ? existing.baseUrl : body.baseUrl || null, apiKey });
  });

  app.post('/api/providers/test', async (req) => {
    const body = providerInput.pick({ kind: true, baseUrl: true, apiKey: true }).parse(req.body);
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
    });
    return repo.profile(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/agent-profiles/:id', async (req) => {
    db.run('DELETE FROM agent_profiles WHERE id = ?', req.params.id);
    return { ok: true };
  });
}
