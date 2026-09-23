import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentProfile } from '@vibe/shared';
import { buildAgentLaunch } from './agents/launch.js';
import { Db } from './db/index.js';
import type { ProviderRecord } from './routes/providers.js';
import { SecretStore } from './secrets.js';

const dir = mkdtempSync(path.join(tmpdir(), 'vibe-test-'));
const db = new Db(path.join(dir, 'db', 'test.sqlite'));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SecretStore', () => {
  it('round-trips and never stores plaintext', () => {
    const secrets = new SecretStore(db, dir, 'master-key');
    const id = secrets.create('k', 'sk-very-secret');
    expect(secrets.get(id)).toBe('sk-very-secret');
    const raw = db.get<{ ciphertext: string }>('SELECT ciphertext FROM secrets WHERE id = ?', id)!;
    expect(raw.ciphertext).not.toContain('sk-very-secret');
    secrets.replace(id, 'sk-new');
    expect(secrets.get(id)).toBe('sk-new');
  });

  it('fails to decrypt with a different master key', () => {
    const a = new SecretStore(db, dir, 'key-a');
    const id = a.create('k', 'value');
    expect(() => new SecretStore(db, dir, 'key-b').get(id)).toThrow();
  });
});

const profile = (p: Partial<AgentProfile>): AgentProfile => ({
  id: 'p1',
  agentKind: 'claude',
  name: 'Test',
  authMode: 'provider',
  providerId: 'prov',
  model: null,
  extraArgs: [],
  env: {},
  createdAt: '',
  ...p,
});

const provider = (p: Partial<ProviderRecord>): ProviderRecord => ({
  id: 'prov',
  kind: 'anthropic',
  name: 'Prov',
  baseUrl: null,
  hasKey: true,
  secretId: 's',
  models: [],
  defaultModel: null,
  createdAt: '',
  ...p,
});

describe('buildAgentLaunch', () => {
  it('passes the Anthropic key only via env and applies the model flag', () => {
    const l = buildAgentLaunch('claude', 'run', {
      profile: profile({ model: 'opus' }),
      provider: provider({}),
      apiKey: 'sk-ant',
    });
    expect(l.command).toBe('claude');
    expect(l.args).toEqual(['--model', 'opus']);
    expect(l.env?.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(JSON.stringify(l.args)).not.toContain('sk-ant');
  });

  it('configures codex for a custom OpenAI-compatible endpoint without leaking the key into args', () => {
    const l = buildAgentLaunch('codex', 'run', {
      profile: profile({ agentKind: 'codex', model: 'qwen3-coder' }),
      provider: provider({ kind: 'openai_compat', baseUrl: 'http://litellm:4000/v1' }),
      apiKey: 'sk-local',
    });
    expect(l.args).toContain('model_providers.vibe.base_url="http://litellm:4000/v1"');
    expect(l.env?.VIBE_PROVIDER_KEY).toBe('sk-local');
    expect(JSON.stringify(l.args)).not.toContain('sk-local');
  });

  it('ignores the provider in subscription mode', () => {
    const l = buildAgentLaunch('claude', 'run', {
      profile: profile({ authMode: 'subscription' }),
      provider: provider({}),
      apiKey: 'sk-ant',
    });
    expect(l.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('runs the login command in login mode', () => {
    const l = buildAgentLaunch('codex', 'login', { profile: null, provider: null, apiKey: null });
    expect([l.command, ...(l.args ?? [])]).toEqual(['codex', 'login', '--device-auth']);
  });
});
