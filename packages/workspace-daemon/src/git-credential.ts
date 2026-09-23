import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseCredentialInput } from './git-parse.js';

/**
 * In-memory git credential store + a local-only endpoint for the credential helper.
 *
 * git (running as `coder`) calls `/opt/wsd/git-credential-vibe get` (configured system-wide via
 * `credential.helper`). The helper forwards git's request over a unix socket that only the
 * daemon's user can open (directory 0700, socket 0600) and prints what wsd answers. Tokens live
 * only in this process' memory — never on disk.
 */
export interface StoredCredential {
  username: string;
  token: string;
}

export class CredentialStore {
  private readonly byHost = new Map<string, StoredCredential>();

  set(host: string, cred: StoredCredential) {
    this.byHost.set(normalizeHost(host), cred);
  }

  clear(host: string) {
    this.byHost.delete(normalizeHost(host));
  }

  /** Answers a git credential "get" request (text in git's key=value format). */
  answer(input: string): string {
    const req = parseCredentialInput(input);
    if (req.protocol && req.protocol !== 'https') return '';
    const cred = req.host ? this.byHost.get(normalizeHost(req.host)) : undefined;
    if (!cred) return '';
    if (req.username && req.username !== cred.username) return '';
    return `username=${cred.username}\npassword=${cred.token}\n`;
  }
}

function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/:443$/, '');
}

/** Socket locations tried in order; the helper script uses the same list. */
export function credentialSocketCandidates(): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const list = [process.env.WSD_CRED_SOCKET, '/run/wsd/cred.sock', path.join(os.tmpdir(), `vibe-wsd-${uid}`, 'cred.sock')];
  return list.filter((p): p is string => !!p);
}

function prepareDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.statSync(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
    if (st.uid !== uid) return false; // not ours (e.g. squatted tmp dir)
    fs.chmodSync(dir, 0o700);
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Starts the unix-socket endpoint. Returns null on platforms without unix sockets (Windows dev). */
export function startCredentialServer(store: CredentialStore): { path: string; close: () => void } | null {
  if (process.platform === 'win32') return null;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/credential') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(store.answer(body));
    });
  });
  for (const sock of credentialSocketCandidates()) {
    if (!prepareDir(path.dirname(sock))) continue;
    try {
      fs.rmSync(sock, { force: true });
    } catch {
      continue;
    }
    const prevUmask = process.umask(0o177);
    try {
      server.listen(sock);
    } finally {
      process.umask(prevUmask);
    }
    server.on('error', (err) => console.error('[wsd] credential socket error:', err));
    try {
      fs.chmodSync(sock, 0o600);
    } catch {
      /* listen is async; chmod happens in 'listening' below as well */
    }
    server.once('listening', () => {
      try {
        fs.chmodSync(sock, 0o600);
      } catch {
        /* ignore */
      }
    });
    server.unref();
    return { path: sock, close: () => server.close() };
  }
  console.error('[wsd] no usable location for the git credential socket; credential helper disabled');
  return null;
}
