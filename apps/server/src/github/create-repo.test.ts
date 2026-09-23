import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../app-context.js';
import { Db } from '../db/index.js';
import type { FetchFn } from './client.js';
import { GitHubService } from './service.js';

const dir = mkdtempSync(path.join(tmpdir(), 'agentforge-gh-'));
const db = new Db(path.join(dir, 'db', 'test.sqlite'));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const rawRepo = {
  id: 1,
  name: 'demo',
  full_name: 'felix/demo',
  owner: { login: 'felix' },
  private: false,
  description: null,
  default_branch: 'main',
  clone_url: 'https://github.com/felix/demo.git',
  html_url: 'https://github.com/felix/demo',
  updated_at: '2026-09-23T00:00:00Z',
};

function service(fetchFn: FetchFn) {
  const svc = new GitHubService({ db } as unknown as AppContext, fetchFn);
  vi.spyOn(svc, 'getToken').mockReturnValue('gho_test');
  return svc;
}

describe('createRepo', () => {
  it('creates a user repo with auto_init and maps the result', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const svc = service(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return json(201, rawRepo);
    });
    const repo = await svc.createRepo({ name: 'demo', private: false, autoInit: true });
    expect(calls[0]!.url).toMatch(/\/user\/repos$/);
    expect(calls[0]!.body).toMatchObject({ name: 'demo', private: false, auto_init: true });
    expect(repo).toMatchObject({ owner: 'felix', name: 'demo', defaultBranch: 'main' });
  });

  it('creates org repos under /orgs/:org/repos and defaults to private without auto_init', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const svc = service(async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return json(201, { ...rawRepo, owner: { login: 'acme' } });
    });
    await svc.createRepo({ name: 'demo', org: 'acme' });
    expect(url).toMatch(/\/orgs\/acme\/repos$/);
    expect(body).toMatchObject({ private: true, auto_init: false });
  });

  it('turns "name already exists" into a German 409', async () => {
    const svc = service(async () =>
      json(422, { message: 'Repository creation failed.', errors: [{ field: 'name', message: 'name already exists on this account' }] }),
    );
    await expect(svc.createRepo({ name: 'demo' })).rejects.toMatchObject({ statusCode: 409, code: 'github_repo_exists' });
  });
});

describe('listOrgs', () => {
  it('maps /user/orgs', async () => {
    const svc = service(async () => json(200, [{ login: 'acme', avatar_url: 'https://x/a.png' }]));
    expect(await svc.listOrgs()).toEqual([{ login: 'acme', avatarUrl: 'https://x/a.png' }]);
  });
});
