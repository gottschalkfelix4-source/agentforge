import type http from 'node:http';
import { filterSetCookie, stripInternalCookies } from './cookies.js';
import { relaxCsp } from './inject.js';

/** Hop-by-hop headers (RFC 7230 §6.1). */
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ForwardInfo {
  /** Container port of the dev server (Host is rewritten to localhost:<port>). */
  port: number;
  /** Public origin of the preview as the browser sees it, e.g. http://host:7100. */
  publicOrigin: string;
  proto: 'http' | 'https';
  remoteAddress: string | undefined;
  /** HTML navigations ask for an uncompressed body so the script can be injected. */
  wantIdentity: boolean;
  /** Keep Connection/Upgrade (WebSocket handshakes). */
  upgrade?: boolean;
}

function rewriteOrigin(value: string, from: string, to: string): string {
  return value === from || value.startsWith(from + '/') ? to + value.slice(from.length) : value;
}

/**
 * Builds the headers sent to the workspace: strips the admin session and slot cookies, moves the browser's
 * Authorization aside (the tunnel restores it; the real Authorization carries the wsd token), rewrites
 * Host/Origin/Referer to what a local dev server expects and sets X-Forwarded-*.
 */
export function forwardRequestHeaders(headers: http.IncomingHttpHeaders, info: ForwardInfo): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const connTokens = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === 'host' || key === 'cookie' || key === 'authorization' || key.startsWith('x-vibe-')) continue;
    if (key.startsWith('x-forwarded-') || key === 'forwarded') continue;
    if (!info.upgrade && (HOP_BY_HOP.has(key) || connTokens.has(key))) continue;
    out[key] = v;
  }
  const local = `http://localhost:${info.port}`;
  out.host = `localhost:${info.port}`;
  const cookie = stripInternalCookies(headers.cookie);
  if (cookie) out.cookie = cookie;
  if (typeof headers.authorization === 'string') out['x-vibe-authorization'] = headers.authorization;
  if (typeof headers.origin === 'string') out.origin = rewriteOrigin(headers.origin, info.publicOrigin, local);
  if (typeof headers.referer === 'string') out.referer = rewriteOrigin(headers.referer, info.publicOrigin, local);
  if (info.wantIdentity) out['accept-encoding'] = 'identity';
  const publicHost = info.publicOrigin.replace(/^https?:\/\//, '');
  out['x-forwarded-host'] = publicHost;
  out['x-forwarded-proto'] = info.proto;
  const prevFor = headers['x-forwarded-for'];
  if (info.remoteAddress) out['x-forwarded-for'] = prevFor ? `${prevFor}, ${info.remoteAddress}` : info.remoteAddress;
  return out;
}

const LOCAL_HOSTS = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:(\d+))?(?=[/?#]|$)/i;

/**
 * Adjusts response headers: allow framing (drop X-Frame-Options / frame-ancestors), relax CSP for our script,
 * never let the preview set the app's own cookies, rewrite absolute redirects to the dev server's local origin.
 */
export function transformResponseHeaders(
  headers: http.IncomingHttpHeaders,
  port: number,
  injecting: boolean,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'x-frame-options' || key.startsWith('x-vibe-')) continue;
    if (key === 'content-security-policy') {
      const values = (Array.isArray(v) ? v : [v]).map(relaxCsp).filter((x): x is string => !!x);
      if (values.length) out[key] = values;
      continue;
    }
    if (key === 'set-cookie') {
      const filtered = filterSetCookie(v);
      if (filtered) out[key] = filtered;
      continue;
    }
    if (key === 'location' && typeof v === 'string') {
      const m = LOCAL_HOSTS.exec(v);
      if (m && (m[3] === undefined ? port === 80 : Number(m[3]) === port)) {
        out[key] = v.slice(m[0].length) || '/';
        continue;
      }
    }
    if (injecting && key === 'content-length') continue;
    out[key] = v;
  }
  return out;
}
