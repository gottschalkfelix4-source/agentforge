import { createHmac, timingSafeEqual } from 'node:crypto';

export const PV_COOKIE_PREFIX = 'vibe_pv_';
/** Slot cookies are valid this long; afterwards the panel requests a fresh one-time token. */
export const PV_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface CookieBinding {
  slot: number;
  projectId: string;
  port: number;
}

export const previewCookieName = (slot: number) => `${PV_COOKIE_PREFIX}${slot}`;

function mac(secret: Buffer, b: CookieBinding, issued: number): string {
  return createHmac('sha256', secret).update(`pv1|${b.slot}|${b.projectId}|${b.port}|${issued}`).digest('base64url');
}

/** Cookie value `<issuedAt>.<hmac>` – the HMAC binds it to slot, project and container port. */
export function signPreviewCookie(secret: Buffer, b: CookieBinding, now = Date.now()): string {
  return `${now}.${mac(secret, b, now)}`;
}

export function verifyPreviewCookie(
  secret: Buffer,
  value: string | undefined,
  b: CookieBinding,
  now = Date.now(),
  maxAgeMs = PV_COOKIE_MAX_AGE_MS,
): boolean {
  if (!value) return false;
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const issued = Number(m[1]);
  if (!Number.isSafeInteger(issued) || issued > now + 60_000 || now - issued > maxAgeMs) return false;
  const a = Buffer.from(m[2]!);
  const e = Buffer.from(mac(secret, b, issued));
  return a.length === e.length && timingSafeEqual(a, e);
}

/** Parses a Cookie header into [name, value] pairs (keeps duplicates and order). */
export function parseCookieHeader(header: string | undefined): [string, string][] {
  if (!header) return [];
  const out: [string, string][] = [];
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out.push([name, part.slice(idx + 1).trim()]);
  }
  return out;
}

export function getCookie(header: string | undefined, name: string): string | undefined {
  return parseCookieHeader(header).find(([n]) => n === name)?.[1];
}

/** Cookies of the app itself that must never reach a previewed dev server. */
export function isInternalCookie(name: string): boolean {
  return name === 'vibe_session' || name.startsWith(PV_COOKIE_PREFIX);
}

/** Removes internal cookies from a Cookie header; returns undefined when nothing is left. */
export function stripInternalCookies(header: string | undefined): string | undefined {
  const kept = parseCookieHeader(header).filter(([n]) => !isInternalCookie(n));
  return kept.length ? kept.map(([n, v]) => `${n}=${v}`).join('; ') : undefined;
}

/** Drops upstream Set-Cookie entries that would overwrite the app's own cookies (same host in port mode). */
export function filterSetCookie(values: string[] | string | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const list = (Array.isArray(values) ? values : [values]).filter((v) => {
    const name = v.slice(0, Math.max(0, v.indexOf('='))).trim();
    return !isInternalCookie(name);
  });
  return list.length ? list : undefined;
}
