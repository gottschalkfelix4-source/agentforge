import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../db/index.js';
import { GitHubClient, rateLimit, type FetchFn } from './client.js';
import { DeviceFlow } from './device-flow.js';
import { combineCi, toChecks, toPull } from './mappers.js';
import { GitHubPoller } from './poller.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('device flow', () => {
  it('walks pending → slow_down → done and throttles polls', async () => {
    let now = 0;
    const calls: string[] = [];
    const tokenReplies = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_abc', scope: 'repo,workflow' }];
    const fetchFn: FetchFn = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/login/device/code')) {
        expect(String(init?.body)).toContain('scope=repo+workflow+read%3Aorg');
        return json(200, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      expect(String(init?.body)).toContain('device_code=dc');
      return json(200, tokenReplies.shift());
    };
    const flow = new DeviceFlow(fetchFn, () => now);
    const start = await flow.start('client-1');
    expect(start).toMatchObject({ userCode: 'ABCD-1234', interval: 5, expiresIn: 900 });

    // Too early: no request to GitHub.
    expect(await flow.poll(start.handle)).toEqual({ status: 'pending' });
    expect(calls).toHaveLength(1);

    now = 5_000;
    expect(await flow.poll(start.handle)).toEqual({ status: 'pending' }); // authorization_pending
    now = 10_000;
    expect(await flow.poll(start.handle)).toEqual({ status: 'pending' }); // slow_down → interval 10 s
    now = 15_000;
    expect(await flow.poll(start.handle)).toEqual({ status: 'pending' }); // throttled
    expect(calls).toHaveLength(3);
    now = 20_000;
    expect(await flow.poll(start.handle)).toEqual({ status: 'done', token: 'gho_abc', scopes: ['repo', 'workflow'] });
    // Handle is consumed.
    expect((await flow.poll(start.handle)).status).toBe('expired');
  });

  it('reports denied, expired and disabled device flow', async () => {
    let now = 0;
    let reply: Record<string, unknown> = { error: 'access_denied' };
    const fetchFn: FetchFn = async (input) =>
      String(input).endsWith('/login/device/code')
        ? json(200, { device_code: 'dc', user_code: 'X', verification_uri: 'u', expires_in: 60, interval: 5 })
        : json(200, reply);
    const flow = new DeviceFlow(fetchFn, () => now);
    const a = await flow.start('c');
    now = 5_000;
    expect((await flow.poll(a.handle)).status).toBe('denied');

    const b = await flow.start('c');
    now = 70_000;
    expect((await flow.poll(b.handle)).status).toBe('expired');

    reply = { error: 'expired_token' };
    const c = await flow.start('c');
    now += 5_000;
    expect((await flow.poll(c.handle)).status).toBe('expired');

    const disabled = new DeviceFlow(async () => json(200, { error: 'device_flow_disabled' }));
    await expect(disabled.start('c')).rejects.toThrow(/Device Flow/);
  });
});

describe('mappers', () => {
  it('combines check runs and statuses into a CI state', () => {
    const checks = toChecks(
      { state: 'success', total_count: 1, statuses: [{ context: 'ci/legacy', state: 'success', target_url: null }] },
      { total_count: 2, check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: null }, { name: 'test', status: 'in_progress', conclusion: null, html_url: null }] },
    );
    expect(checks).toHaveLength(3);
    expect(combineCi(checks)).toBe('pending');
    expect(combineCi([{ name: 'a', status: 'completed', conclusion: 'failure', htmlUrl: null }, { name: 'b', status: 'queued', conclusion: null, htmlUrl: null }])).toBe('failure');
    expect(combineCi([{ name: 'a', status: 'completed', conclusion: 'skipped', htmlUrl: null }])).toBe('neutral');
    expect(combineCi([])).toBe('none');
    expect(combineCi(toChecks(null, { total_count: 1, check_runs: [{ name: 'x', status: 'completed', conclusion: 'success', html_url: null }] }))).toBe('success');
  });

  it('maps merged pulls', () => {
    const pr = toPull({
      number: 3, title: 't', body: null, state: 'closed', merged_at: '2024-01-01', head: { ref: 'f', sha: 's' }, base: { ref: 'main' },
      user: { login: 'u' }, html_url: 'h', created_at: 'c', updated_at: 'u',
    });
    expect(pr.state).toBe('merged');
  });
});

describe('ETag poller', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gh-test-'));
  const db = new Db(path.join(dir, 'db', 'test.sqlite'));
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.run("INSERT INTO projects (id, name, slug, created_at, archived) VALUES ('p1', 'P', 'p', '2024', 0)");

  let pullsEtag = 'W/"p1"';
  let pulls: unknown[] = [];
  let statusEtag = 'W/"s1"';
  let checksEtag = 'W/"c1"';
  const requests: { url: string; ifNoneMatch: string | null }[] = [];

  const fetchFn: FetchFn = async (input, init) => {
    const url = String(input);
    const inm = (init?.headers as Record<string, string>)['If-None-Match'] ?? null;
    requests.push({ url, ifNoneMatch: inm });
    const rl = { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '9999999999' };
    const reply = (etag: string, body: unknown) => (inm === etag ? json(304, null, { etag, ...rl }) : json(200, body, { etag, ...rl }));
    if (url.includes('/pulls')) return reply(pullsEtag, pulls);
    if (url.endsWith('/status')) return reply(statusEtag, { state: 'pending', total_count: 0, statuses: [] });
    if (url.includes('/check-runs')) return reply(checksEtag, { total_count: 0, check_runs: [] });
    return json(404, {});
  };

  let now = 1_000_000;
  const published: string[] = [];
  const poller = new GitHubPoller({
    db,
    client: () => new GitHubClient('t', fetchFn),
    linked: () => [{ projectId: 'p1', owner: 'o', name: 'r' }],
    publish: (id) => published.push(id),
    now: () => now,
  });

  beforeEach(() => {
    requests.length = 0;
  });

  it('records a baseline, then uses conditional requests', async () => {
    pulls = [{ number: 1, head: { sha: 'aaa' } }];
    expect(await poller.tick()).toEqual([]); // first poll = baseline
    expect(requests.map((r) => r.ifNoneMatch)).toEqual([null, null, null]);
    expect(rateLimit.remaining).toBe(4999);

    now += 60_000;
    expect(await poller.tick()).toEqual([]);
    expect(requests.slice(-3).map((r) => r.ifNoneMatch)).toEqual(['W/"p1"', 'W/"s1"', 'W/"c1"']);
    const cursor = db.get<{ etag: string }>("SELECT etag FROM sync_cursors WHERE project_id = 'p1' AND resource = 'gh:pulls'");
    expect(cursor?.etag).toBe('W/"p1"');
  });

  it('publishes when CI or pulls change', async () => {
    checksEtag = 'W/"c2"';
    now += 60_000;
    expect(await poller.tick()).toEqual(['p1']);

    pullsEtag = 'W/"p2"';
    pulls = [{ number: 1, head: { sha: 'bbb' } }];
    now += 60_000;
    expect(await poller.tick()).toEqual(['p1']);
    // New head sha → CI requests are unconditional.
    expect(requests.slice(-2).map((r) => r.ifNoneMatch)).toEqual([null, null]);
    expect(published).toEqual(['p1', 'p1']);
  });

  it('polls idle repos (no open PRs) only every 5 minutes and pauses when rate limited', async () => {
    pullsEtag = 'W/"p3"';
    pulls = [];
    now += 60_000;
    await poller.tick();
    requests.length = 0;
    now += 60_000;
    await poller.tick();
    expect(requests).toHaveLength(0);
    now += 5 * 60_000;
    await poller.tick();
    expect(requests).toHaveLength(1);

    requests.length = 0;
    now += 6 * 60_000; // idle interval passed, but the rate limit is nearly exhausted
    rateLimit.remaining = 10;
    rateLimit.resetAt = now + 60_000;
    await poller.tick();
    expect(requests).toHaveLength(0);
    rateLimit.remaining = null;
  });
});
