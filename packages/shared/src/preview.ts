// Live preview (Phase 4).
//
// Port mode (default): the app listens on PREVIEW_PORT_START..+PREVIEW_PORT_COUNT-1; each slot maps to
// (project, container port). First request must carry `?__vibe_pv=<token>`; the proxy then sets a
// slot cookie and redirects to the clean URL. Traffic goes app → wsd `/proxy/<port>/…` → 127.0.0.1:<port>.
// Subdomain mode: `https://p<slot>.<PREVIEW_DOMAIN>` routed on the main port.

export interface PreviewSlot {
  slot: number;
  projectId: string;
  /** Port inside the workspace container. */
  port: number;
  /** Port mode: host port the browser connects to (same hostname as the app). */
  hostPort: number | null;
  /** Subdomain mode: full origin, e.g. https://p3.preview.example.com */
  origin: string | null;
  /** One-time token to append as `?__vibe_pv=` on the first load. */
  token: string;
  createdAt: string;
}

export interface OpenPreviewRequest { port: number }

/** Messages the injected preview script posts to the parent window. */
export type PreviewMessage =
  | { source: 'vibe-preview'; type: 'console'; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; args: string[]; ts: number }
  | { source: 'vibe-preview'; type: 'error'; message: string; stack?: string; ts: number }
  | { source: 'vibe-preview'; type: 'navigate'; url: string; title: string; ts: number }
  | { source: 'vibe-preview'; type: 'ready'; url: string; ts: number }
  /** Sent by the proxy's 401/404 page: the slot cookie is missing/expired – request a new token. */
  | { source: 'vibe-preview'; type: 'auth-required'; ts: number };

/** Messages the parent posts into the preview frame. */
export type PreviewCommand =
  | { source: 'vibe-parent'; type: 'reload' }
  | { source: 'vibe-parent'; type: 'back' }
  | { source: 'vibe-parent'; type: 'forward' };

export const PREVIEW_QUERY_TOKEN = '__vibe_pv';
export const PREVIEW_INJECT_PATH = '/__vibe/inject.js';
