import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { handleProxyRequest, handleProxyUpgrade, isProxyPortAllowed, upstreamHeaders } from '../src/tunnel.js';

let app: http.Server;
let proxy: http.Server;
let appPort = 0;
let proxyPort = 0;

beforeAll(async () => {
  app = http.createServer((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 200);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  const wss = new WebSocketServer({ server: app });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m.toString()}`)));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  appPort = (app.address() as AddressInfo).port;

  proxy = http.createServer((req, res) => {
    const m = /^\/proxy\/(\d+)(\/.*)?$/.exec(req.url ?? '')!;
    handleProxyRequest(req, res, Number(m[1]), m[2] ?? '/');
  });
  proxy.on('upgrade', (req, socket, head) => {
    const m = /^\/proxy\/(\d+)(\/.*)?$/.exec(req.url ?? '')!;
    handleProxyUpgrade(req, socket, head, Number(m[1]), m[2] ?? '/');
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(() => {
  app.close();
  proxy.close();
});

describe('tunnel', () => {
  it('rejects invalid ports and the daemon port', () => {
    expect(isProxyPortAllowed(0)).toBe(false);
    expect(isProxyPortAllowed(70000)).toBe(false);
    expect(isProxyPortAllowed(7777, 7777)).toBe(false);
    expect(isProxyPortAllowed(3000, 7777)).toBe(true);
  });

  it('strips the bearer token and restores the app authorization header', () => {
    const h = upstreamHeaders({ authorization: 'Bearer wsd', 'x-vibe-authorization': 'Basic abc', connection: 'keep-alive, x-foo', 'x-foo': '1', accept: 'a' });
    expect(h.authorization).toBe('Basic abc');
    expect(h['x-foo']).toBeUndefined();
    expect(h.connection).toBeUndefined();
    expect(h.accept).toBe('a');
  });

  it('forwards method, path, body', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/proxy/${appPort}/echo?x=1`, {
      method: 'POST',
      body: 'hello',
      headers: { authorization: 'Bearer secret' },
    });
    const j = (await res.json()) as { method: string; url: string; headers: Record<string, string>; body: string };
    expect(j).toMatchObject({ method: 'POST', url: '/echo?x=1', body: 'hello' });
    expect(j.headers.authorization).toBeUndefined();
  });

  it('streams SSE without buffering', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/proxy/${appPort}/sse`);
    const reader = res.body!.getReader();
    const t0 = Date.now();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('one');
    expect(Date.now() - t0).toBeLessThan(150);
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('two');
  });

  it('returns 502 when nothing listens', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/proxy/1/`);
    expect(res.status).toBe(502);
  });

  it('pipes websocket upgrades', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/proxy/${appPort}/hmr`);
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (m) => resolve(m.toString()));
      ws.on('error', reject);
    });
    expect(msg).toBe('echo:ping');
    ws.close();
  });
});
