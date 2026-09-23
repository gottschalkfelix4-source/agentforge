import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { loadConfig } from './config.js';

// Phase 4 – preview tunnel: `/proxy/<port>/<path>` → http://127.0.0.1:<port>/<path> (HTTP + WebSocket).
// Auth (wsd bearer token) is checked by the caller (server.ts) for both HTTP requests and upgrades.
// The app server moves a browser-supplied Authorization header to `x-vibe-authorization`
// because the real Authorization header carries the wsd token; we restore it here.

const ORIG_AUTH_HEADER = 'x-vibe-authorization';

/** Hop-by-hop headers (RFC 7230 §6.1) that must not be forwarded by a proxy. */
const HOP_BY_HOP = new Set([
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

const selfPort = loadConfig().port;

export function isProxyPortAllowed(port: number, wsdPort = selfPort): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535 && port !== wsdPort;
}

/** Headers to send upstream: strips hop-by-hop + the wsd bearer, restores the app's own Authorization. */
export function upstreamHeaders(headers: http.IncomingHttpHeaders, keepUpgrade = false): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  const connectionTokens = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === 'authorization' || key === ORIG_AUTH_HEADER) continue;
    if (!keepUpgrade && (HOP_BY_HOP.has(key) || connectionTokens.has(key))) continue;
    out[key] = v;
  }
  const orig = headers[ORIG_AUTH_HEADER];
  if (typeof orig === 'string' && orig) out.authorization = orig;
  return out;
}

/** Connects to the dev server on IPv4 loopback, falling back to IPv6 loopback (e.g. Vite binding `::1`). */
export function connectLoopback(port: number, hosts = ['127.0.0.1', '::1']): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (i: number) => {
      const sock = net.connect({ host: hosts[i]!, port });
      const onError = (err: NodeJS.ErrnoException) => {
        sock.destroy();
        if (i + 1 < hosts.length && (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) {
          attempt(i + 1);
        } else reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.off('error', onError);
        resolve(sock);
      });
    };
    attempt(0);
  });
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Tagged so the app server can render a friendly page instead of the dev server's own error.
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-vibe-tunnel-error': '1' });
  res.end(message);
}

export function handleProxyRequest(req: http.IncomingMessage, res: http.ServerResponse, port: number, path: string): void {
  if (!isProxyPortAllowed(port)) return sendError(res, 403, `port ${port} is not allowed`);

  let upstreamReq: http.ClientRequest | null = null;
  // `res` closes when the response finished or the client went away; in both cases the upstream is done.
  res.on('close', () => upstreamReq?.destroy());
  req.on('error', () => upstreamReq?.destroy());
  const headers = upstreamHeaders(req.headers);

  // The request body is only piped once the TCP connection is up, so a refused IPv4 attempt can be
  // retried on IPv6 loopback without losing body bytes.
  const attempt = (i: number) => {
    let connected = false;
    const r = http.request({ host: LOOPBACK[i], port, method: req.method, path, headers, agent: false });
    upstreamReq = r;
    r.once('socket', (s) => {
      s.setNoDelay(true);
      const onConnect = () => {
        connected = true;
        req.pipe(r);
      };
      if (s.connecting) s.once('connect', onConnect);
      else onConnect();
    });
    r.on('response', (up) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k)) continue;
        out[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
      // Flush headers right away so streaming responses (SSE) start immediately.
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    r.on('error', (err: NodeJS.ErrnoException) => {
      if (!connected && i + 1 < LOOPBACK.length && RETRY_CODES.has(err.code ?? '') && !res.destroyed) return attempt(i + 1);
      if (!connected && err.code === 'ECONNREFUSED') return sendError(res, 502, `Auf Port ${port} lauscht kein Server.`);
      sendError(res, 502, `upstream error: ${err.message}`);
    });
  };
  attempt(0);
}

const LOOPBACK = ['127.0.0.1', '::1'];
const RETRY_CODES = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/** Serializes an upgrade request line + headers for a raw socket. */
export function serializeUpgradeRequest(method: string, path: string, rawHeaders: string[]): string {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const lower = name.toLowerCase();
    if (lower === 'authorization') continue;
    if (lower === ORIG_AUTH_HEADER) {
      lines.push(`Authorization: ${rawHeaders[i + 1]}`);
      continue;
    }
    lines.push(`${name}: ${rawHeaders[i + 1]}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

export function handleProxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, port: number, path: string): void {
  if (!isProxyPortAllowed(port)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  socket.on('error', () => socket.destroy());
  connectLoopback(port).then(
    (up) => {
      if (socket.destroyed) return up.destroy();
      up.setNoDelay(true);
      up.write(serializeUpgradeRequest(req.method ?? 'GET', path, req.rawHeaders));
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
      up.on('error', () => socket.destroy());
      up.on('close', () => socket.destroy());
      socket.on('close', () => up.destroy());
    },
    () => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    },
  );
}
