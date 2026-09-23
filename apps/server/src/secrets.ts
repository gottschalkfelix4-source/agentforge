import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import type { Db } from './db/index.js';
import { nowIso } from './db/index.js';

/**
 * AES-256-GCM encryption of secrets at rest. The master key comes from VIBE_SECRET_KEY, or —
 * as a weaker fallback — from an auto-generated key file next to the database.
 */
export class SecretStore {
  private readonly key: Buffer;
  readonly keyFromEnv: boolean;

  constructor(private readonly db: Db, dataDir: string, envKey: string | null) {
    if (envKey) {
      this.key = createHash('sha256').update(envKey).digest();
      this.keyFromEnv = true;
    } else {
      const file = path.join(dataDir, 'secret.key');
      if (!existsSync(file)) {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
      }
      this.key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      this.keyFromEnv = false;
    }
  }

  create(name: string, value: string): string {
    const id = ulid();
    this.db.insert('secrets', { id, name, ...this.encrypt(value), key_version: 1, created_at: nowIso() });
    return id;
  }

  replace(id: string, value: string) {
    this.db.update('secrets', id, this.encrypt(value));
  }

  get(id: string): string | null {
    const row = this.db.get<{ ciphertext: string; iv: string; tag: string }>(
      'SELECT ciphertext, iv, tag FROM secrets WHERE id = ?',
      id,
    );
    if (!row) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }

  delete(id: string) {
    this.db.run('DELETE FROM secrets WHERE id = ?', id);
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }
}
