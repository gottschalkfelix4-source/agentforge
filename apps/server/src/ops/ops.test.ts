import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { afterAll, describe, expect, it } from 'vitest';
import { Db } from '../db/index.js';
import { createBackupStream, type BackupManifest } from './backup.js';
import { effectiveIdleMinutes, evaluateIdle, isBusy, setStoredIdleMinutes, storedIdleMinutes } from './idle.js';
import { diskUsage } from './system-info.js';

const dir = mkdtempSync(path.join(tmpdir(), 'vibe-ops-test-'));
const dataDir = path.join(dir, 'data');
const db = new Db(path.join(dataDir, 'db', 'vibe.sqlite'));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function readTar(stream: NodeJS.ReadableStream): Promise<Map<string, { type: string; body: Buffer }>> {
  const files = new Map<string, { type: string; body: Buffer }>();
  const extract = tar.extract();
  extract.on('entry', (header, s, next) => {
    const chunks: Buffer[] = [];
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('end', () => {
      files.set(header.name, { type: header.type ?? 'file', body: Buffer.concat(chunks) });
      next();
    });
    s.resume();
  });
  await pipeline(stream, createGunzip(), extract);
  return files;
}

describe('backup', () => {
  db.run("INSERT INTO settings (key, value_json) VALUES ('backupTest', '\"hello\"')");
  writeFileSync(path.join(dataDir, 'secret.key'), 'a2V5');
  mkdirSync(path.join(dataDir, 'projects', 'p1', 'src'), { recursive: true });
  mkdirSync(path.join(dataDir, 'projects', 'p1', 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(dataDir, 'projects', 'p1', 'src', 'index.ts'), 'console.log(1)\n');
  writeFileSync(path.join(dataDir, 'projects', 'p1', 'node_modules', 'x', 'big.js'), 'ignored');

  it('contains a valid SQLite snapshot, manifest and file-based key', async () => {
    const files = await readTar(createBackupStream({ db: db.raw, dataDir, version: 'test', includeProjects: false, keyFromEnv: false }));
    expect([...files.keys()].sort()).toEqual(['manifest.json', 'secret.key', 'vibe.sqlite']);

    const manifest = JSON.parse(files.get('manifest.json')!.body.toString()) as BackupManifest;
    expect(manifest.format).toBe('agentforge-backup');
    expect(manifest.includesSecretKey).toBe(true);
    expect(manifest.warnings.length).toBeGreaterThan(0);
    expect(files.get('secret.key')!.body.toString()).toBe('a2V5');

    const snap = path.join(dir, 'restored.sqlite');
    writeFileSync(snap, files.get('vibe.sqlite')!.body);
    const restored = new DatabaseSync(snap);
    try {
      expect(restored.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(restored.prepare("SELECT value_json FROM settings WHERE key = 'backupTest'").get()).toEqual({ value_json: '"hello"' });
      const v = restored.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(v.user_version).toBeGreaterThan(0);
    } finally {
      restored.close();
    }
  });

  it('omits the key when it comes from the environment and includes projects without node_modules', async () => {
    const files = await readTar(createBackupStream({ db: db.raw, dataDir, version: 'test', includeProjects: true, keyFromEnv: true }));
    expect(files.has('secret.key')).toBe(false);
    expect(files.get('projects/p1/src/index.ts')?.body.toString()).toBe('console.log(1)\n');
    expect([...files.keys()].some((k) => k.includes('node_modules'))).toBe(false);
    const manifest = JSON.parse(files.get('manifest.json')!.body.toString()) as BackupManifest;
    expect(manifest.includesProjects).toBe(true);
    expect(manifest.includesSecretKey).toBe(false);
  });
});

describe('idle auto-stop', () => {
  const MIN = 60_000;

  it('classifies busy workspaces', () => {
    expect(isBusy([], [])).toBe(false);
    expect(isBusy([{ exited: true }], [{ running: false }])).toBe(false);
    expect(isBusy([{ exited: false }], [])).toBe(true);
    expect(isBusy([], [{ running: true }])).toBe(true);
  });

  it('stops only after N consecutive idle minutes', () => {
    let state = new Map<string, number>();
    const step = (t: number, busy: boolean | null) => {
      const d = evaluateIdle(state, [{ projectId: 'a', busy }], t * MIN, 10 * MIN);
      state = d.idleSince;
      return d.stop;
    };
    expect(step(0, false)).toEqual([]);
    expect(step(5, false)).toEqual([]);
    expect(step(9, true)).toEqual([]); // activity resets
    expect(step(10, false)).toEqual([]);
    expect(step(15, null)).toEqual([]); // unknown resets as well (never stop blindly)
    expect(step(16, false)).toEqual([]);
    expect(step(25, false)).toEqual([]);
    expect(step(26, false)).toEqual(['a']);
    expect(state.has('a')).toBe(false);
  });

  it('is disabled at 0 and forgets workspaces that are gone', () => {
    const prev = new Map([['gone', 0]]);
    expect(evaluateIdle(prev, [{ projectId: 'a', busy: false }], 100 * MIN, 0).stop).toEqual([]);
    const d = evaluateIdle(prev, [{ projectId: 'a', busy: false }], 100 * MIN, 5 * MIN);
    expect(d.stop).toEqual([]);
    expect([...d.idleSince.keys()]).toEqual(['a']);
  });

  it('stored setting overrides the environment default', () => {
    const old = process.env.WORKSPACE_IDLE_MINUTES;
    process.env.WORKSPACE_IDLE_MINUTES = '30';
    try {
      expect(effectiveIdleMinutes(db)).toBe(30);
      setStoredIdleMinutes(db, 0);
      expect(storedIdleMinutes(db)).toBe(0);
      expect(effectiveIdleMinutes(db)).toBe(0);
      setStoredIdleMinutes(db, 15);
      expect(effectiveIdleMinutes(db)).toBe(15);
      setStoredIdleMinutes(db, null);
      expect(effectiveIdleMinutes(db)).toBe(30);
    } finally {
      if (old === undefined) delete process.env.WORKSPACE_IDLE_MINUTES;
      else process.env.WORKSPACE_IDLE_MINUTES = old;
    }
  });
});

describe('diskUsage', () => {
  it('sums files per top-level entry and respects the budget', async () => {
    const du = await diskUsage(path.join(dataDir, 'projects'));
    expect(du.entries[0]!.name).toBe('p1');
    expect(du.totalBytes).toBe('console.log(1)\n'.length + 'ignored'.length);
    expect(du.partial).toBe(false);
    const limited = await diskUsage(path.join(dataDir, 'projects'), { maxEntries: 2, maxMs: 10_000, maxDepth: 64 });
    expect(limited.partial).toBe(true);
  });
});
