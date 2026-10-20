import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../app-context.js';
import { Auth } from '../auth.js';
import { Db, nowIso } from '../db/index.js';
import { updateBody } from './projects.js';
import { projectUsesProvider, providerRepo } from './providers.js';

const dir = mkdtempSync(path.join(tmpdir(), 'vibe-sec-test-'));
const db = new Db(path.join(dir, 'db', 'test.sqlite'));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const project = (id: string) => db.insert('projects', { id, name: id, slug: id, created_at: nowIso() });
const provider = (id: string) => db.insert('providers', { id, kind: 'openai_chatgpt', name: id, created_at: nowIso() });
const profile = (id: string, providerId: string, authMode = 'provider') =>
  db.insert('agent_profiles', { id, agent_kind: 'codex', name: id, auth_mode: authMode, provider_id: providerId, created_at: nowIso() });
const session = (id: string, projectId: string, profileId: string) =>
  db.insert('agent_sessions', {
    id,
    project_id: projectId,
    agent_id: 'codex',
    profile_id: profileId,
    transport: 'acp',
    title: id,
    status: 'idle',
    created_at: nowIso(),
    updated_at: nowIso(),
  });

describe('ChatGPT token scope', () => {
  project('pa');
  project('pb');
  provider('gpt1');
  provider('gpt2');
  profile('prof1', 'gpt1');
  profile('prof2', 'gpt2', 'subscription');

  it('denies a provider the project never used', () => {
    expect(projectUsesProvider(db, 'pa', 'gpt1')).toBe(false);
    expect(projectUsesProvider(db, 'pa', 'unknown')).toBe(false);
  });

  it('allows the provider of a chat session profile, only in that project', () => {
    session('s1', 'pa', 'prof1');
    expect(projectUsesProvider(db, 'pa', 'gpt1')).toBe(true);
    expect(projectUsesProvider(db, 'pb', 'gpt1')).toBe(false);
  });

  it('ignores profiles that do not authenticate through the provider', () => {
    session('s2', 'pb', 'prof2');
    expect(projectUsesProvider(db, 'pb', 'gpt2')).toBe(false);
  });

  it('allows a provider granted by an agent terminal launch', () => {
    const repo = providerRepo({ db } as AppContext);
    repo.grantProject('pb', repo.get('gpt2')!);
    repo.grantProject('pb', repo.get('gpt2')!); // idempotent
    expect(projectUsesProvider(db, 'pb', 'gpt2')).toBe(true);
    expect(projectUsesProvider(db, 'pa', 'gpt2')).toBe(false);
  });
});

describe('session cookie', () => {
  const cookieOpts = (secureCookies: boolean, protocol: 'http' | 'https') => {
    const setCookie = vi.fn();
    const auth = new Auth(db, dir, () => undefined, secureCookies);
    auth.createSession({ headers: {}, ip: '127.0.0.1', protocol } as unknown as FastifyRequest, { setCookie } as unknown as FastifyReply);
    return setCookie.mock.calls[0]![2] as { secure: boolean };
  };

  it('is Secure over https or when AGENTFORGE_SECURE_COOKIES is set', () => {
    expect(cookieOpts(false, 'http').secure).toBe(false);
    expect(cookieOpts(false, 'https').secure).toBe(true);
    expect(cookieOpts(true, 'http').secure).toBe(true);
  });
});

describe('project PATCH body', () => {
  it('validates repoOwner/repoName like create', () => {
    expect(updateBody.parse({ repoOwner: 'octo-org', repoName: 'my.repo_1' })).toEqual({ repoOwner: 'octo-org', repoName: 'my.repo_1' });
    expect(updateBody.parse({ repoOwner: null })).toEqual({ repoOwner: null });
    expect(() => updateBody.parse({ repoOwner: '../evil' })).toThrow();
    expect(() => updateBody.parse({ repoName: 'a b' })).toThrow();
    expect(() => updateBody.parse({ repoName: 'x'.repeat(101) })).toThrow();
  });
});
