import { HttpError } from '../workspaces/manager.js';

export type FetchFn = typeof fetch;

export const GITHUB_API = 'https://api.github.com';

/** Last seen rate-limit headers (shared by all clients; there is one GitHub account). */
export const rateLimit = { remaining: null as number | null, limit: null as number | null, resetAt: null as number | null };

export interface GhResponse<T> {
  status: number;
  data: T;
  etag: string | null;
  headers: Headers;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Sends If-None-Match; a 304 response is returned (not thrown) with data = null. */
  etag?: string | null;
}

/** Minimal GitHub REST client on top of fetch (injectable for tests). */
export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly base = GITHUB_API,
  ) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<GhResponse<T>> {
    const url = new URL(path.startsWith('http') ? path : `${this.base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Agentforge',
    };
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new HttpError(502, 'github_unreachable', `GitHub nicht erreichbar: ${(err as Error).message}`);
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      rateLimit.remaining = Number(remaining);
      rateLimit.limit = Number(res.headers.get('x-ratelimit-limit') ?? 0) || null;
      const reset = res.headers.get('x-ratelimit-reset');
      rateLimit.resetAt = reset ? Number(reset) * 1000 : null;
    }
    const etag = res.headers.get('etag');
    if (res.status === 304) return { status: 304, data: null as T, etag: etag ?? opts.etag ?? null, headers: res.headers };
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw toHttpError(res.status, data, res.headers);
    return { status: res.status, data: data as T, etag, headers: res.headers };
  }

  async get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return (await this.request<T>('GET', path, { query })).data;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('POST', path, { body })).data;
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('PATCH', path, { body })).data;
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('PUT', path, { body })).data;
  }
}

function toHttpError(status: number, data: unknown, headers: Headers): HttpError {
  const obj = (data && typeof data === 'object' ? data : {}) as { message?: string; errors?: { message?: string; code?: string; field?: string }[] };
  const detail = [obj.message, ...(obj.errors ?? []).map((e) => e.message ?? [e.field, e.code].filter(Boolean).join(' '))]
    .filter(Boolean)
    .join(' – ');
  if (status === 401) return new HttpError(400, 'github_unauthorized', 'GitHub-Token ist ungültig oder wurde widerrufen');
  if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
    return new HttpError(429, 'github_rate_limited', 'GitHub-Rate-Limit erreicht – bitte später erneut versuchen');
  }
  if (status === 403) return new HttpError(403, 'github_forbidden', `GitHub verweigert den Zugriff${detail ? `: ${detail}` : ''}`);
  if (status === 404) return new HttpError(404, 'github_not_found', 'Auf GitHub nicht gefunden (oder kein Zugriff)');
  if (status === 405 || status === 409) return new HttpError(409, 'github_conflict', detail || 'Aktion auf GitHub nicht möglich');
  if (status === 422) return new HttpError(400, 'github_invalid', detail || 'GitHub hat die Anfrage abgelehnt');
  return new HttpError(502, 'github_error', `GitHub-Fehler ${status}${detail ? `: ${detail}` : ''}`);
}
