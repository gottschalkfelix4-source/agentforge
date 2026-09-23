import { PREVIEW_QUERY_TOKEN, type PreviewSlot } from '@vibe/shared';
import { request } from '@/lib/api';

const p = (id: string) => `/projects/${encodeURIComponent(id)}/previews`;

export const previewApi = {
  /** Idempotent: returns the slot for (project, port) with a fresh one-time token. */
  open: (projectId: string, port: number) => request<PreviewSlot>(p(projectId), { method: 'POST', body: { port } }),
  list: (projectId: string) => request<PreviewSlot[]>(p(projectId)),
  remove: (slot: number) => request<{ ok: true }>(`/previews/${slot}`, { method: 'DELETE' }),
};

/** Normalizes an in-app path ("foo" → "/foo"). */
export function normalizePath(path: string): string {
  const t = path.trim();
  if (!t) return '/';
  return t.startsWith('/') ? t : `/${t}`;
}

/** URL the browser loads for a slot: origin of the slot + in-app path + one-time token. */
export function frameUrl(slot: PreviewSlot, path: string): string {
  const origin = slot.origin ?? `${window.location.protocol}//${window.location.hostname}:${slot.hostPort}`;
  const norm = normalizePath(path);
  const hashAt = norm.indexOf('#');
  const beforeHash = hashAt < 0 ? norm : norm.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : norm.slice(hashAt);
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${origin}${beforeHash}${sep}${PREVIEW_QUERY_TOKEN}=${encodeURIComponent(slot.token)}${hash}`;
}

/**
 * Interprets what the user typed into the URL bar: an in-app path ("/about"), or a local URL
 * ("localhost:3000/x", "http://127.0.0.1:5173/") which may also switch the port.
 */
export function parseAddress(input: string): { port: number | null; path: string } {
  const t = input.trim();
  const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{1,5}))?(\/.*)?$/i.exec(t);
  if (m) {
    const port = m[1] ? Number(m[1]) : null;
    return { port: port && port > 0 && port <= 65535 ? port : null, path: normalizePath(m[2] ?? '/') };
  }
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return { port: null, path: `${u.pathname}${u.search}${u.hash}` };
    } catch {
      /* fall through */
    }
  }
  return { port: null, path: normalizePath(t) };
}
