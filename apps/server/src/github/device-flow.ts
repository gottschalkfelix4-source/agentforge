import { randomUUID } from 'node:crypto';
import type { GitHubDeviceStart } from '@vibe/shared';
import { HttpError } from '../workspaces/manager.js';
import type { FetchFn } from './client.js';

export const DEVICE_SCOPES = 'repo workflow read:org';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface Pending {
  clientId: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'done'; token: string; scopes: string[] }
  | { status: 'expired' | 'denied' | 'error'; message: string };

/**
 * GitHub OAuth device flow (https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
 * Keeps device codes server-side; the browser only gets an opaque handle. Polls are throttled to
 * GitHub's interval (+5 s on slow_down), so the browser may poll as often as it likes.
 */
export class DeviceFlow {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
    private readonly baseUrl = 'https://github.com',
  ) {}

  private async post(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Agentforge' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new HttpError(502, 'github_unreachable', `GitHub nicht erreichbar: ${(err as Error).message}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new HttpError(502, 'github_error', `Unerwartete Antwort von GitHub (${res.status})`);
    }
  }

  async start(clientId: string, scope = DEVICE_SCOPES): Promise<GitHubDeviceStart> {
    const data = await this.post('/login/device/code', { client_id: clientId, scope });
    if (typeof data.error === 'string' || typeof data.device_code !== 'string') {
      const msg =
        data.error === 'device_flow_disabled'
          ? 'Device Flow ist für diese OAuth-App nicht aktiviert (GitHub → Developer settings → OAuth App → „Enable Device Flow“).'
          : data.error === 'unauthorized_client' || data.error === 'incorrect_client_credentials'
            ? 'Ungültige OAuth Client-ID'
            : `GitHub: ${String(data.error_description ?? data.error ?? 'unbekannter Fehler')}`;
      throw new HttpError(400, 'github_device_flow', msg);
    }
    const handle = randomUUID();
    const interval = Number(data.interval ?? 5);
    const expiresIn = Number(data.expires_in ?? 900);
    this.pending.set(handle, {
      clientId,
      deviceCode: data.device_code,
      intervalMs: interval * 1000,
      expiresAt: this.now() + expiresIn * 1000,
      nextPollAt: this.now() + interval * 1000,
    });
    this.gc();
    return {
      handle,
      userCode: String(data.user_code),
      verificationUri: String(data.verification_uri ?? 'https://github.com/login/device'),
      expiresIn,
      interval,
    };
  }

  async poll(handle: string): Promise<DevicePollResult> {
    const p = this.pending.get(handle);
    if (!p) return { status: 'expired', message: 'Anmeldung abgelaufen oder unbekannt – bitte neu starten' };
    const now = this.now();
    if (now >= p.expiresAt) {
      this.pending.delete(handle);
      return { status: 'expired', message: 'Der Code ist abgelaufen – bitte neu starten' };
    }
    if (now < p.nextPollAt) return { status: 'pending' };
    p.nextPollAt = now + p.intervalMs;
    const data = await this.post('/login/oauth/access_token', { client_id: p.clientId, device_code: p.deviceCode, grant_type: GRANT_TYPE });
    if (typeof data.access_token === 'string') {
      this.pending.delete(handle);
      const scopes = String(data.scope ?? '').split(/[\s,]+/).filter(Boolean);
      return { status: 'done', token: data.access_token, scopes };
    }
    switch (data.error) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        p.intervalMs = (typeof data.interval === 'number' ? data.interval * 1000 : p.intervalMs + 5000);
        p.nextPollAt = now + p.intervalMs;
        return { status: 'pending' };
      case 'expired_token':
        this.pending.delete(handle);
        return { status: 'expired', message: 'Der Code ist abgelaufen – bitte neu starten' };
      case 'access_denied':
        this.pending.delete(handle);
        return { status: 'denied', message: 'Anmeldung wurde auf GitHub abgelehnt' };
      default:
        this.pending.delete(handle);
        return { status: 'error', message: `GitHub: ${String(data.error_description ?? data.error ?? 'unbekannter Fehler')}` };
    }
  }

  private gc() {
    const now = this.now();
    for (const [h, p] of this.pending) if (now >= p.expiresAt) this.pending.delete(h);
  }
}
