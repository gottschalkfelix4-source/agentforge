import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgentManifest } from '@vibe/shared';
import { modelsRequest, testProvider } from './provider-test.js';
import { combineStatus, compareVersions, installLaunch, LatestVersions } from './service.js';

describe('compareVersions', () => {
  it('orders numerically and puts pre-releases first', () => {
    expect(compareVersions('0.156.1', '0.160.0')).toBe(-1);
    expect(compareVersions('2.1.280', '2.1.28')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
});

describe('installLaunch', () => {
  it('npm agents install the package + extras @latest via a bash terminal', () => {
    const l = installLaunch('claude');
    expect(l.command).toBe('bash');
    expect(l.args?.[1]).toContain('npm install -g --no-audit --no-fund @anthropic-ai/claude-code@latest @agentclientprotocol/claude-agent-acp@latest');
  });
  it('uses the manifest installCommand for non-npm agents', () => {
    expect(installLaunch('aider').args?.[1]).toContain('uv tool install --force --python /usr/bin/python3 aider-chat@latest');
    expect(installLaunch('goose').args?.[1]).toContain('/opt/vibe-tools/bin/goose');
  });
});

describe('LatestVersions / combineStatus', () => {
  it('caches lookups and computes updateAvailable', async () => {
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      if (url.includes('registry.npmjs.org/@openai%2Fcodex/latest')) return Response.json({ version: '0.200.0' });
      if (url.includes('pypi.org/pypi/aider-chat/json')) return Response.json({ info: { version: '0.90.0' } });
      if (url.includes('api.github.com/repos/block/goose')) return Response.json({ tag_name: 'v1.60.0' });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const latest = new LatestVersions(fake);
    const list = await combineStatus([{ agentId: 'codex', bin: 'codex', version: '0.156.1' }, { agentId: 'goose', bin: 'goose', version: '1.60.0' }], latest);
    const codex = list.find((t) => t.agentId === 'codex')!;
    expect(codex).toMatchObject({ installed: '0.156.1', latest: '0.200.0', updateAvailable: true, chat: true, installable: true });
    expect(list.find((t) => t.agentId === 'goose')).toMatchObject({ latest: '1.60.0', updateAvailable: false });
    expect(list.find((t) => t.agentId === 'aider')).toMatchObject({ installed: null, latest: '0.90.0', chat: false });
    const before = calls;
    await combineStatus(null, latest);
    expect(calls).toBe(before);
  });
});

describe('provider test', () => {
  let server: Server;
  let base: string;
  const seen: { url: string; auth?: string; xkey?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url!, auth: req.headers.authorization, xkey: req.headers['x-api-key'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization === 'Bearer bad' || req.headers['x-api-key'] === 'bad') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'invalid key bad' } }));
      }
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }] }));
      if (req.url?.startsWith('/v1/models?limit')) return res.end(JSON.stringify({ data: [{ id: 'claude-x' }] }));
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('lists OpenAI-compatible models sorted', async () => {
    expect(await testProvider({ kind: 'openai_compat', baseUrl: `${base}/v1`, apiKey: 'k' })).toEqual({ ok: true, models: ['a-model', 'b-model'] });
    expect(seen.at(-1)).toMatchObject({ url: '/v1/models', auth: 'Bearer k' });
  });
  it('uses /api/tags for Ollama (even with a /v1 base URL)', async () => {
    expect(await testProvider({ kind: 'ollama', baseUrl: `${base}/v1`, apiKey: '' })).toEqual({ ok: true, models: ['qwen3:8b'] });
  });
  it('uses x-api-key for Anthropic-compatible endpoints', async () => {
    expect(await testProvider({ kind: 'anthropic_compat', baseUrl: base, apiKey: 'ak' })).toEqual({ ok: true, models: ['claude-x'] });
    expect(seen.at(-1)).toMatchObject({ xkey: 'ak' });
  });
  it('reports HTTP errors without echoing the key', async () => {
    const r = await testProvider({ kind: 'openai_compat', baseUrl: `${base}/v1`, apiKey: 'bad' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
    expect(r.error).not.toContain('bad');
  });
  it('reports unreachable hosts and timeouts', async () => {
    const r = await testProvider({ kind: 'openai_compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' }, fetch, 2000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Nicht erreichbar|Zeitüberschreitung/);
  });
  it('builds the default endpoints', () => {
    expect(modelsRequest({ kind: 'openai', baseUrl: null, apiKey: 'k' }).url).toBe('https://api.openai.com/v1/models');
    expect(modelsRequest({ kind: 'openrouter', baseUrl: null, apiKey: 'k' }).verifyUrl).toBe('https://openrouter.ai/api/v1/key');
    expect(modelsRequest({ kind: 'anthropic', baseUrl: null, apiKey: 'k' }).url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(modelsRequest({ kind: 'gemini', baseUrl: null, apiKey: 'k' }).headers['x-goog-api-key']).toBe('k');
    expect(getAgentManifest('gemini')?.providerKinds).toEqual(['gemini']);
  });
});
