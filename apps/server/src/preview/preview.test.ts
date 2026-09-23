import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  filterSetCookie,
  getCookie,
  signPreviewCookie,
  stripInternalCookies,
  verifyPreviewCookie,
} from './cookies.js';
import { forwardRequestHeaders, transformResponseHeaders } from './headers.js';
import { HtmlInjector, INJECT_TAG, injectHtml, relaxCsp, shouldInject } from './inject.js';
import { PreviewService, stripTokenParam } from './service.js';
import { SlotTable } from './slots.js';

async function streamThrough(chunks: string[]): Promise<string> {
  const out: Buffer[] = [];
  const inj = new HtmlInjector();
  inj.on('data', (b: Buffer) => out.push(b));
  await new Promise<void>((resolve, reject) => {
    Readable.from(chunks.map((c) => Buffer.from(c, 'latin1'))).pipe(inj).on('end', resolve).on('error', reject);
  });
  return Buffer.concat(out).toString('latin1');
}

describe('HTML injection', () => {
  it('injects right after <head>', () => {
    expect(injectHtml('<!doctype html><html><head><title>x</title></head><body></body></html>')).toBe(
      `<!doctype html><html><head>${INJECT_TAG}<title>x</title></head><body></body></html>`,
    );
    expect(injectHtml('<HEAD lang="x">a')).toBe(`<HEAD lang="x">${INJECT_TAG}a`);
  });

  it('does not mistake <header> for <head>', () => {
    expect(injectHtml('<!DOCTYPE html><body><header>h</header></body>')).toBe(`<!DOCTYPE html>${INJECT_TAG}<body><header>h</header></body>`);
  });

  it('falls back to after <html>, after doctype, or the start', () => {
    expect(injectHtml('<html lang="de"><body>x</body></html>')).toBe(`<html lang="de">${INJECT_TAG}<body>x</body></html>`);
    expect(injectHtml('<!doctype html>\n<p>hi</p>')).toBe(`<!doctype html>${INJECT_TAG}\n<p>hi</p>`);
    expect(injectHtml('<p>fragment</p>')).toBe(`${INJECT_TAG}<p>fragment</p>`);
  });

  it('streams: head split across chunks, rest passed through', async () => {
    const out = await streamThrough(['<!doctype html><html><he', 'ad><meta charset="utf-8">', '<body>ä</body>']);
    expect(out).toBe(`<!doctype html><html><head>${INJECT_TAG}<meta charset="utf-8"><body>ä</body>`);
  });

  it('streams: document without head is injected at the end of input', async () => {
    expect(await streamThrough(['<p>a', 'b</p>'])).toBe(`${INJECT_TAG}<p>ab</p>`);
  });

  it('only injects uncompressed HTML documents', () => {
    expect(shouldInject('GET', 200, { 'content-type': 'text/html; charset=utf-8' })).toBe(true);
    expect(shouldInject('GET', 200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })).toBe(false);
    expect(shouldInject('GET', 200, { 'content-type': 'text/html', 'content-encoding': 'br' })).toBe(false);
    expect(shouldInject('GET', 200, { 'content-type': 'application/json' })).toBe(false);
    expect(shouldInject('HEAD', 200, { 'content-type': 'text/html' })).toBe(false);
    expect(shouldInject('GET', 304, { 'content-type': 'text/html' })).toBe(false);
  });

  it('relaxes CSP: drops frame-ancestors, allows self scripts', () => {
    expect(relaxCsp("default-src 'none'; frame-ancestors 'none'")).toBe("default-src 'self'");
    expect(relaxCsp("script-src 'self' 'unsafe-eval'; frame-ancestors 'self'")).toBe("script-src 'self' 'unsafe-eval'");
    expect(relaxCsp("script-src https://cdn.x; img-src *")).toBe("script-src https://cdn.x 'self'; img-src *");
    expect(relaxCsp('frame-ancestors none')).toBeNull();
  });
});

describe('preview cookies', () => {
  const secret = randomBytes(32);
  const b = { slot: 3, projectId: 'p1', port: 5173 };

  it('signs and verifies', () => {
    const v = signPreviewCookie(secret, b);
    expect(verifyPreviewCookie(secret, v, b)).toBe(true);
  });

  it('is bound to slot, project, port and secret', () => {
    const v = signPreviewCookie(secret, b);
    expect(verifyPreviewCookie(secret, v, { ...b, slot: 4 })).toBe(false);
    expect(verifyPreviewCookie(secret, v, { ...b, projectId: 'p2' })).toBe(false);
    expect(verifyPreviewCookie(secret, v, { ...b, port: 3000 })).toBe(false);
    expect(verifyPreviewCookie(randomBytes(32), v, b)).toBe(false);
  });

  it('rejects tampered, malformed and expired values', () => {
    const now = Date.now();
    const v = signPreviewCookie(secret, b, now);
    const [ts, mac] = v.split('.');
    expect(verifyPreviewCookie(secret, `${Number(ts) + 1}.${mac}`, b, now)).toBe(false);
    expect(verifyPreviewCookie(secret, 'garbage', b)).toBe(false);
    expect(verifyPreviewCookie(secret, undefined, b)).toBe(false);
    expect(verifyPreviewCookie(secret, v, b, now + 13 * 3600_000)).toBe(false);
  });

  it('strips the admin session and slot cookies', () => {
    expect(stripInternalCookies('a=1; vibe_session=secret; vibe_pv_0=x; b=2; vibe_pv_12=y')).toBe('a=1; b=2');
    expect(stripInternalCookies('vibe_session=secret')).toBeUndefined();
    expect(getCookie('a=1; vibe_pv_2=abc', 'vibe_pv_2')).toBe('abc');
    expect(filterSetCookie(['vibe_session=evil; Path=/', 'sid=1; HttpOnly'])).toEqual(['sid=1; HttpOnly']);
  });

  it('strips the token query parameter only', () => {
    expect(stripTokenParam('/a/b?x=1&__vibe_pv=tok&y=%20')).toEqual({ path: '/a/b?x=1&y=%20', token: 'tok' });
    expect(stripTokenParam('/?__vibe_pv=t')).toEqual({ path: '/', token: 't' });
    expect(stripTokenParam('/x')).toEqual({ path: '/x', token: null });
  });
});

describe('slot allocation', () => {
  it('reuses the slot of the same project+port', () => {
    const t = new SlotTable(3);
    const a = t.acquire('p', 3000);
    const b = t.acquire('p', 3000);
    expect(b.entry.slot).toBe(a.entry.slot);
    expect(b.created).toBe(false);
    expect(t.acquire('p', 3001).entry.slot).not.toBe(a.entry.slot);
  });

  it('evicts the least recently used slot when full', () => {
    let now = 1000;
    const t = new SlotTable(2, () => now);
    const s0 = t.acquire('p', 1).entry.slot;
    now += 10;
    const s1 = t.acquire('p', 2).entry.slot;
    now += 10;
    t.touch(s0); // slot of port 1 is now more recent
    now += 10;
    const r = t.acquire('q', 3);
    expect(r.evicted?.port).toBe(2);
    expect(r.entry.slot).toBe(s1);
    expect(t.list().map((s) => s.port).sort()).toEqual([1, 3]);
  });

  it('skips disabled slots', () => {
    const t = new SlotTable(2);
    t.disable(0);
    expect(t.acquire('p', 1).entry.slot).toBe(1);
  });

  it('tokens are one-time, slot-bound and expire after 60 s', () => {
    let now = 0;
    const t = new SlotTable(2, () => now);
    const s = t.acquire('p', 1).entry.slot;
    const tok = t.issueToken(s);
    expect(t.consumeToken(tok, s + 1)).toBe(false); // wrong slot (and consumed)
    const tok2 = t.issueToken(s);
    expect(t.consumeToken(tok2, s)).toBe(true);
    expect(t.consumeToken(tok2, s)).toBe(false);
    const tok3 = t.issueToken(s);
    now += 61_000;
    expect(t.consumeToken(tok3, s)).toBe(false);
  });

  it('tokens die with an evicted slot', () => {
    const t = new SlotTable(1);
    const s = t.acquire('p', 1).entry.slot;
    const tok = t.issueToken(s);
    t.acquire('q', 2);
    expect(t.consumeToken(tok, s)).toBe(false);
  });
});

describe('header handling', () => {
  const info = { port: 5173, publicOrigin: 'http://host:7100', proto: 'http' as const, remoteAddress: '10.0.0.2', wantIdentity: true };

  it('strips internal cookies/auth and rewrites Host/Origin', () => {
    const h = forwardRequestHeaders(
      {
        host: 'host:7100',
        cookie: 'vibe_session=admin; vibe_pv_0=x; theme=dark',
        authorization: 'Basic app',
        origin: 'http://host:7100',
        referer: 'http://host:7100/page',
        connection: 'keep-alive',
        'accept-encoding': 'gzip, br',
        'x-vibe-authorization': 'spoof',
        'x-forwarded-host': 'evil',
      },
      info,
    );
    expect(h.cookie).toBe('theme=dark');
    expect(h.host).toBe('localhost:5173');
    expect(h.origin).toBe('http://localhost:5173');
    expect(h.referer).toBe('http://localhost:5173/page');
    expect(h['x-vibe-authorization']).toBe('Basic app');
    expect(h.authorization).toBeUndefined();
    expect(h.connection).toBeUndefined();
    expect(h['accept-encoding']).toBe('identity');
    expect(h['x-forwarded-host']).toBe('host:7100');
    expect(h['x-forwarded-for']).toBe('10.0.0.2');
  });

  it('keeps upgrade headers for websockets and drops the cookie header when empty', () => {
    const h = forwardRequestHeaders({ connection: 'Upgrade', upgrade: 'websocket', cookie: 'vibe_session=a' }, { ...info, upgrade: true, wantIdentity: false });
    expect(h.upgrade).toBe('websocket');
    expect(h.cookie).toBeUndefined();
  });

  it('transforms response headers', () => {
    const h = transformResponseHeaders(
      {
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'; script-src 'none'",
        'content-length': '100',
        'set-cookie': ['vibe_session=x', 'a=b'],
        location: 'http://localhost:5173/login?x=1',
        'x-vibe-tunnel-error': '1',
      },
      5173,
      true,
    );
    expect(h['x-frame-options']).toBeUndefined();
    expect(h['content-security-policy']).toEqual(["script-src 'self'"]);
    expect(h['content-length']).toBeUndefined();
    expect(h['set-cookie']).toEqual(['a=b']);
    expect(h.location).toBe('/login?x=1');
    expect(h['x-vibe-tunnel-error']).toBeUndefined();
    expect(transformResponseHeaders({ location: 'http://localhost:3000/x' }, 5173, false).location).toBe('http://localhost:3000/x');
  });
});

// ---- end-to-end through a fake wsd -------------------------------------------------

describe('PreviewService (port mode) end-to-end', () => {
  let wsd: http.Server;
  let service: PreviewService;
  const seen: http.IncomingHttpHeaders[] = [];
  const start = 17600 + Math.floor(Math.random() * 300);

  beforeAll(async () => {
    // Fake wsd: echoes headers, serves HTML, checks the bearer, echoes websockets.
    wsd = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer wsd-token') return void res.writeHead(401).end();
      seen.push(req.headers);
      if (req.url?.startsWith('/proxy/5173/page')) {
        const body = '<html><head><title>t</title></head></html>';
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length), 'x-frame-options': 'DENY' });
        return void res.end(body);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    });
    const wss = new WebSocketServer({ noServer: true });
    wsd.on('upgrade', (req, socket, head) => {
      if (req.headers.authorization !== 'Bearer wsd-token') return socket.destroy();
      seen.push(req.headers);
      wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo:${m.toString()}`)));
    });
    await new Promise<void>((r) => wsd.listen(0, '127.0.0.1', r));
    const wsdPort = (wsd.address() as AddressInfo).port;
    service = new PreviewService(
      { previewMode: 'port', previewDomain: null, previewPortStart: start, previewPortCount: 2, host: '127.0.0.1' },
      async () => ({ host: '127.0.0.1', port: wsdPort, token: 'wsd-token' }),
      { info: () => undefined, warn: () => undefined },
      () => undefined,
    );
    await service.startPortListeners();
  });

  afterAll(async () => {
    await service.close();
    wsd.close();
  });

  it('requires the token, sets a cookie, injects and strips', async () => {
    const slot = service.open('proj', 5173, 'http');
    const base = `http://127.0.0.1:${slot.hostPort}`;
    expect((await fetch(`${base}/page`, { redirect: 'manual' })).status).toBe(401);

    const r1 = await fetch(`${base}/page?a=1&__vibe_pv=${slot.token}`, { redirect: 'manual' });
    expect(r1.status).toBe(302);
    expect(r1.headers.get('location')).toBe('/page?a=1');
    const setCookie = r1.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^vibe_pv_\d+=.*HttpOnly; SameSite=Lax/);
    const cookie = setCookie.split(';')[0]!;

    // token is one-time
    expect((await fetch(`${base}/page?__vibe_pv=${slot.token}`, { redirect: 'manual' })).status).toBe(401);

    const r2 = await fetch(`${base}/page?a=1`, {
      headers: { cookie: `${cookie}; vibe_session=admin; keep=1`, accept: 'text/html', 'accept-encoding': 'gzip' },
    });
    const html = await r2.text();
    expect(html).toContain(`<head>${INJECT_TAG}<title>`);
    expect(r2.headers.get('x-frame-options')).toBeNull();
    const h = seen.at(-1)!;
    expect(h.cookie).toBe('keep=1');
    expect(h.host).toBe('localhost:5173');
    expect(h['accept-encoding']).toBe('identity');

    const js = await fetch(`${base}/__vibe/inject.js`);
    expect(await js.text()).toContain('vibe-preview');

    const ws = new WebSocket(`ws://127.0.0.1:${slot.hostPort}/hmr`, { headers: { cookie } });
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (m) => resolve(m.toString()));
      ws.on('error', reject);
    });
    expect(msg).toBe('echo:hi');
    expect(seen.at(-1)!.cookie).toBeUndefined();
    ws.close();

    const noCookie = new WebSocket(`ws://127.0.0.1:${slot.hostPort}/hmr`);
    await expect(new Promise((resolve, reject) => { noCookie.on('open', resolve); noCookie.on('error', reject); })).rejects.toThrow(/401/);
  });
});
