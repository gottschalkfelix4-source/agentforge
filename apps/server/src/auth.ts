import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';
import type { Db } from './db/index.js';
import { nowIso } from './db/index.js';

export const SESSION_COOKIE = 'vibe_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Auth {
  /** One-time token required for the first-run admin setup; null once an admin exists. */
  private setupToken: string | null = null;

  constructor(private readonly db: Db, private readonly dataDir: string, private readonly log: (msg: string) => void) {
    if (!this.hasAdmin()) {
      this.setupToken = randomBytes(9).toString('base64url');
      const file = path.join(dataDir, 'setup-token.txt');
      writeFileSync(file, this.setupToken + '\n', { mode: 0o600 });
      log(`\n==============================================\n  Agentforge Setup-Token: ${this.setupToken}\n  (auch in ${file})\n==============================================\n`);
    }
  }

  hasAdmin(): boolean {
    return !!this.db.get('SELECT id FROM admin LIMIT 1');
  }

  async setup(token: string, username: string, password: string) {
    if (this.hasAdmin() || !this.setupToken) throw new AuthError('already_setup', 'Setup wurde bereits abgeschlossen');
    const a = Buffer.from(token.trim());
    const b = Buffer.from(this.setupToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError('invalid_token', 'Setup-Token ist ungültig');
    if (username.trim().length < 2) throw new AuthError('invalid_input', 'Benutzername zu kurz');
    if (password.length < 8) throw new AuthError('invalid_input', 'Passwort muss mindestens 8 Zeichen haben');
    this.db.insert('admin', { id: ulid(), username: username.trim(), pw_hash: await hash(password), created_at: nowIso() });
    this.setupToken = null;
    rmSync(path.join(this.dataDir, 'setup-token.txt'), { force: true });
  }

  async login(username: string, password: string): Promise<boolean> {
    const row = this.db.get<{ pw_hash: string }>('SELECT pw_hash FROM admin WHERE username = ?', username.trim());
    if (!row) {
      // Spend comparable time to avoid a username oracle.
      await hash(password);
      return false;
    }
    return verify(row.pw_hash, password);
  }

  createSession(req: FastifyRequest, reply: FastifyReply) {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    this.db.insert('auth_sessions', {
      id: ulid(),
      token_hash: sha256(token),
      created_at: nowIso(),
      expires_at: expires.toISOString(),
      user_agent: req.headers['user-agent'] ?? null,
      ip: req.ip,
    });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https',
      expires,
    });
  }

  destroySession(req: FastifyRequest, reply: FastifyReply) {
    const token = req.cookies[SESSION_COOKIE];
    if (token) this.db.run('DELETE FROM auth_sessions WHERE token_hash = ?', sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** Validates the session cookie of a request. */
  isAuthenticated(cookieToken: string | undefined): boolean {
    if (!cookieToken) return false;
    const row = this.db.get<{ expires_at: string }>(
      'SELECT expires_at FROM auth_sessions WHERE token_hash = ?',
      sha256(cookieToken),
    );
    return !!row && new Date(row.expires_at).getTime() > Date.now();
  }

  username(): string | null {
    return this.db.get<{ username: string }>('SELECT username FROM admin LIMIT 1')?.username ?? null;
  }

  pruneSessions() {
    this.db.run('DELETE FROM auth_sessions WHERE expires_at < ?', nowIso());
  }
}

export class AuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
