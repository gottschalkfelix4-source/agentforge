import { describe, expect, it } from 'vitest';
import { testChatGptProvider } from '../tools/provider-test.js';
import { ChatGptAuth, needsRefresh, toTokens, type ChatGptTokens } from './auth.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const AUTH = 'https://api.openai.com/auth';
const idToken = jwt({ email: 'me@example.com', [AUTH]: { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'pro' } });

describe('chatgpt device flow', () => {
  it('walks usercode → pending → token exchange and keeps the login until it is taken', async () => {
    let now = 0;
    const calls: { url: string; body: string; type: string }[] = [];
    const tokenReplies = [json(403, { error: 'pending' }), json(200, { authorization_code: 'code-1', code_verifier: 'ver-1', code_challenge: 'x' })];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body), type: new Headers(init?.headers).get('content-type') ?? '' });
      if (url.endsWith('/usercode')) return json(200, { device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '5' });
      if (url.endsWith('/deviceauth/token')) return tokenReplies.shift()!;
      return json(200, { access_token: jwt({ exp: 7200 }), refresh_token: 'rt-1', id_token: idToken });
    }) as typeof fetch;
    const auth = new ChatGptAuth(fetchFn, () => now, 'https://auth.test');
    const start = await auth.deviceStart();
    expect(start).toMatchObject({ userCode: 'ABCD-EFGH', interval: 5, verificationUri: 'https://auth.openai.com/codex/device' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });

    expect(await auth.devicePoll(start.handle)).toEqual({ status: 'pending' }); // throttled, no request
    expect(calls).toHaveLength(1);
    now = 5_000;
    expect(await auth.devicePoll(start.handle)).toEqual({ status: 'pending' }); // 403
    now = 10_000;
    expect(await auth.devicePoll(start.handle)).toEqual({ status: 'done', account: { email: 'me@example.com', planType: 'pro' } });
    const exchange = calls.at(-1)!;
    expect(exchange.url).toBe('https://auth.test/oauth/token');
    expect(exchange.type).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'ver-1',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
    });

    // Polling again after success still reports done; the tokens can be taken exactly once.
    expect((await auth.devicePoll(start.handle)).status).toBe('done');
    expect(auth.peekLogin(start.handle)?.refreshToken).toBe('rt-1');
    const t = auth.takeLogin(start.handle)!;
    expect(t).toMatchObject({ accountId: 'acc-1', refreshToken: 'rt-1', expiresAt: 7_200_000, obtainedAt: 10_000 });
    expect(auth.takeLogin(start.handle)).toBeNull();
  });

  it('refresh keeps fields the response leaves out and maps a used refresh token to relogin', async () => {
    const prev = toTokens({ access_token: jwt({ exp: 100 }), refresh_token: 'rt-1', id_token: idToken }, 0);
    let reply = json(200, { access_token: jwt({ exp: 5000 }), refresh_token: 'rt-2' });
    let sent: unknown;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return reply;
    }) as typeof fetch;
    const auth = new ChatGptAuth(fetchFn, () => 1000);
    const fresh = await auth.refresh(prev);
    expect(sent).toEqual({ grant_type: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: 'rt-1' });
    expect(fresh).toMatchObject({ refreshToken: 'rt-2', accountId: 'acc-1', email: 'me@example.com', expiresAt: 5_000_000, idToken });

    reply = json(401, { error: { code: 'refresh_token_reused', message: 'reused' } });
    await expect(auth.refresh(fresh)).rejects.toMatchObject({ code: 'chatgpt_relogin' });
  });

  it('needsRefresh: wants the minimum validity, capped at half the lifetime', () => {
    const h = 3_600_000;
    const t = { obtainedAt: 0, expiresAt: 10 * 24 * h } as ChatGptTokens;
    expect(needsRefresh(t, 0, 24 * h)).toBe(false);
    expect(needsRefresh(t, 9.5 * 24 * h, 24 * h)).toBe(true);
    const short = { obtainedAt: 0, expiresAt: h } as ChatGptTokens;
    expect(needsRefresh(short, 0, 24 * h)).toBe(false); // margin = 30 min, not 24 h
    expect(needsRefresh(short, 0.6 * h, 24 * h)).toBe(true);
  });
});

describe('chatgpt model catalog', () => {
  it('lists visible models with the account header', async () => {
    let headers: Headers | null = null;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return json(200, { models: [{ slug: 'gpt-5.5', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' }, { slug: 'gpt-6-sol' }] });
    }) as typeof fetch;
    expect(await testChatGptProvider({ accessToken: 'at', accountId: 'acc-1' }, fetchFn)).toEqual({ ok: true, models: ['gpt-5.5', 'gpt-6-sol'] });
    expect(headers!.get('authorization')).toBe('Bearer at');
    expect(headers!.get('chatgpt-account-id')).toBe('acc-1');
    expect(await testChatGptProvider(null)).toMatchObject({ ok: false });
  });
});
