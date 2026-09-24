import { randomUUID } from 'node:crypto';
import type { ChatGptAccount, ChatGptDevicePoll, ChatGptDeviceStart } from '@vibe/shared';
import { HttpError } from '../workspaces/manager.js';

// "Sign in with ChatGPT" for ChatGPT Plus/Pro subscriptions — the device flow of the Codex CLI
// (codex-rs/login: device_code_auth.rs, auth/manager.rs). Agentforge logs in once and refreshes centrally;
// agents only ever get a current access token (refresh tokens are single-use and must not leave the server).

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
const DEVICE_URL = `${CHATGPT_ISSUER}/codex/device`;
const REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;
const DEVICE_TTL_MS = 15 * 60_000;
/** A finished login waits this long for the provider to be saved. */
const LOGIN_TTL_MS = 30 * 60_000;

type Fetch = typeof fetch;

/** What Agentforge stores (encrypted) as the secret of an openai_chatgpt provider. */
export interface ChatGptTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  planType: string | null;
  email: string | null;
  /** Access token expiry (ms epoch, from its JWT). */
  expiresAt: number;
  /** When the tokens were obtained (ms epoch). */
  obtainedAt: number;
}

interface PendingDevice {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
}

/** Payload of a JWT (no signature check — the tokens come straight from auth.openai.com over TLS). */
export function jwtClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Builds the stored token record from an OAuth token response (fields missing on refresh are kept). */
export function toTokens(
  res: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown },
  now: number,
  prev?: ChatGptTokens,
): ChatGptTokens {
  const accessToken = typeof res.access_token === 'string' ? res.access_token : '';
  if (!accessToken) throw new HttpError(502, 'chatgpt_error', 'OpenAI hat kein Access-Token geliefert');
  const idToken = typeof res.id_token === 'string' && res.id_token ? res.id_token : (prev?.idToken ?? '');
  const refreshToken = typeof res.refresh_token === 'string' && res.refresh_token ? res.refresh_token : (prev?.refreshToken ?? '');
  const id = jwtClaims(idToken);
  const auth = (id['https://api.openai.com/auth'] ?? jwtClaims(accessToken)['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const accountId = typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : (prev?.accountId ?? '');
  if (!accountId) throw new HttpError(502, 'chatgpt_error', 'Kein ChatGPT-Konto im Token gefunden – ist das Konto ein ChatGPT-Abo?');
  const exp = Number(jwtClaims(accessToken).exp);
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    planType: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : (prev?.planType ?? null),
    email: typeof id.email === 'string' ? id.email : (prev?.email ?? null),
    // Without a readable exp assume one hour, so the token is refreshed early rather than too late.
    expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : now + 3_600_000,
    obtainedAt: now,
  };
}

export const accountOf = (t: ChatGptTokens): ChatGptAccount => ({ email: t.email, planType: t.planType });

/**
 * Whether a token should be refreshed before handing it out: when less than `minValidMs` remain, capped at
 * half its lifetime (so short-lived tokens are not refreshed on every call).
 */
export function needsRefresh(t: ChatGptTokens, now: number, minValidMs: number): boolean {
  const lifetime = Math.max(0, t.expiresAt - t.obtainedAt);
  const margin = Math.max(5 * 60_000, Math.min(minValidMs, lifetime / 2));
  return t.expiresAt - now < margin;
}

export class ChatGptAuth {
  private readonly devices = new Map<string, PendingDevice>();
  private readonly logins = new Map<string, { tokens: ChatGptTokens; expiresAt: number }>();

  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly issuer = CHATGPT_ISSUER,
  ) {}

  private async post(path: string, body: Record<string, string>, form = false): Promise<{ status: number; data: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.issuer}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new HttpError(502, 'chatgpt_unreachable', `OpenAI nicht erreichbar: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON error page */
    }
    return { status: res.status, data };
  }

  async deviceStart(): Promise<ChatGptDeviceStart> {
    const { status, data } = await this.post('/api/accounts/deviceauth/usercode', { client_id: CHATGPT_CLIENT_ID });
    const userCode = data.user_code ?? data.usercode;
    if (status !== 200 || typeof data.device_auth_id !== 'string' || typeof userCode !== 'string') {
      const msg = status === 404 ? 'Geräte-Anmeldung ist bei OpenAI nicht verfügbar' : `OpenAI: ${errorText(data) ?? `HTTP ${status}`}`;
      throw new HttpError(502, 'chatgpt_device_flow', msg);
    }
    const interval = Math.max(1, Number(data.interval) || 5);
    const handle = randomUUID();
    const now = this.now();
    this.devices.set(handle, {
      deviceAuthId: data.device_auth_id,
      userCode,
      intervalMs: interval * 1000,
      expiresAt: now + DEVICE_TTL_MS,
      nextPollAt: now + interval * 1000,
    });
    this.gc();
    return { handle, userCode, verificationUri: DEVICE_URL, expiresIn: DEVICE_TTL_MS / 1000, interval };
  }

  /** Polls a device login (throttled to OpenAI's interval). On success the tokens wait for `takeLogin`. */
  async devicePoll(handle: string): Promise<ChatGptDevicePoll> {
    const done = this.logins.get(handle);
    if (done) return { status: 'done', account: accountOf(done.tokens) };
    const d = this.devices.get(handle);
    if (!d) return { status: 'expired', message: 'Anmeldung abgelaufen oder unbekannt – bitte neu starten' };
    const now = this.now();
    if (now >= d.expiresAt) {
      this.devices.delete(handle);
      return { status: 'expired', message: 'Der Code ist abgelaufen – bitte neu starten' };
    }
    if (now < d.nextPollAt) return { status: 'pending' };
    d.nextPollAt = now + d.intervalMs;
    const { status, data } = await this.post('/api/accounts/deviceauth/token', { device_auth_id: d.deviceAuthId, user_code: d.userCode });
    // 403/404 = not confirmed yet.
    if (status === 403 || status === 404) return { status: 'pending' };
    if (status !== 200 || typeof data.authorization_code !== 'string' || typeof data.code_verifier !== 'string') {
      this.devices.delete(handle);
      return { status: 'error', message: `OpenAI: ${errorText(data) ?? `HTTP ${status}`}` };
    }
    this.devices.delete(handle);
    const ex = await this.post(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: CHATGPT_CLIENT_ID,
        code: data.authorization_code,
        redirect_uri: REDIRECT_URI,
        code_verifier: data.code_verifier,
      },
      true,
    );
    if (ex.status !== 200) return { status: 'error', message: `Token-Austausch fehlgeschlagen: ${errorText(ex.data) ?? `HTTP ${ex.status}`}` };
    let tokens: ChatGptTokens;
    try {
      tokens = toTokens(ex.data, this.now());
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    }
    if (!tokens.refreshToken) return { status: 'error', message: 'OpenAI hat kein Refresh-Token geliefert' };
    this.logins.set(handle, { tokens, expiresAt: this.now() + LOGIN_TTL_MS });
    return { status: 'done', account: accountOf(tokens) };
  }

  /** The tokens of a finished login (once). */
  takeLogin(handle: string): ChatGptTokens | null {
    this.gc();
    const l = this.logins.get(handle);
    this.logins.delete(handle);
    return l?.tokens ?? null;
  }

  /** A finished login without consuming it (connection test before saving). */
  peekLogin(handle: string): ChatGptTokens | null {
    this.gc();
    return this.logins.get(handle)?.tokens ?? null;
  }

  /** Refreshes the tokens; the refresh token rotates, so the result must be stored right away. */
  async refresh(t: ChatGptTokens): Promise<ChatGptTokens> {
    const { status, data } = await this.post('/oauth/token', { grant_type: 'refresh_token', client_id: CHATGPT_CLIENT_ID, refresh_token: t.refreshToken });
    if (status !== 200) {
      const code = typeof data.error === 'object' && data.error ? (data.error as { code?: unknown }).code : data.error;
      if (status === 400 || status === 401 || /refresh_token_(reused|expired|invalidated)|invalid_grant/.test(String(code))) {
        throw new HttpError(401, 'chatgpt_relogin', 'Die ChatGPT-Anmeldung ist abgelaufen – bitte den Provider neu anmelden (Einstellungen → Provider)');
      }
      throw new HttpError(502, 'chatgpt_error', `ChatGPT-Token konnte nicht erneuert werden: ${errorText(data) ?? `HTTP ${status}`}`);
    }
    return toTokens(data, this.now(), t);
  }

  private gc() {
    const now = this.now();
    for (const [h, d] of this.devices) if (now >= d.expiresAt) this.devices.delete(h);
    for (const [h, l] of this.logins) if (now >= l.expiresAt) this.logins.delete(h);
  }
}

function errorText(data: Record<string, unknown>): string | null {
  const e = data.error;
  if (typeof e === 'string') return typeof data.error_description === 'string' ? data.error_description : e;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown; code?: unknown }).message ?? (e as { code?: unknown }).code;
    if (typeof m === 'string') return m;
  }
  return typeof data.message === 'string' ? data.message : null;
}
