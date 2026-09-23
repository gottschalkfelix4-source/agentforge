import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

type TarHeader = Partial<tar.Header> & { name: string };

/** Directory names that are never included when project files are exported (reproducible, huge). */
export const BACKUP_EXCLUDED_DIRS = new Set(['node_modules', '.pnpm-store', '.venv', '__pycache__', '.next', '.turbo', '.cache']);

export interface BackupOptions {
  /** Open database handle; a consistent snapshot is taken with `VACUUM INTO`. */
  db: DatabaseSync;
  dataDir: string;
  version: string;
  /** Include `<dataDir>/projects` (without dependency/build caches). */
  includeProjects: boolean;
  /** True when the encryption key comes from VIBE_SECRET_KEY (then secret.key is not part of the backup). */
  keyFromEnv: boolean;
  log?: { warn: (m: string) => void };
}

export interface BackupManifest {
  format: 'agentforge-backup';
  formatVersion: 1;
  createdAt: string;
  appVersion: string;
  contents: string[];
  includesProjects: boolean;
  includesSecretKey: boolean;
  warnings: string[];
  excludedDirs: string[];
}

/** Takes a consistent snapshot of the live database into `file` (must not exist yet). */
export function snapshotDatabase(db: DatabaseSync, file: string) {
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
}

/**
 * Streams a `.tar.gz` backup: `vibe.sqlite` (consistent snapshot), `manifest.json`,
 * `secret.key` (only if the key is file-based) and optionally `projects/…`.
 */
export function createBackupStream(opts: BackupOptions): Readable {
  const pack = tar.pack();
  // If the download is aborted, the pack stream is destroyed and pending entry callbacks never fire;
  // this promise rejects then, so the writer loop ends and the temp snapshot is cleaned up.
  const closed = new Promise<never>((_, reject) => pack.once('close', () => reject(new Error('Backup-Stream geschlossen'))));
  closed.catch(() => undefined);
  const w: Writer = { pack, closed };
  const gzip = createGzip({ level: 6 });
  const out = new PassThrough();
  pipeline(pack, gzip, out).catch((err: Error) => out.destroy(err));

  void (async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'vibe-backup-'));
    try {
      const snapshot = path.join(tmp, 'vibe.sqlite');
      snapshotDatabase(opts.db, snapshot);

      const warnings: string[] = [];
      const keyFile = path.join(opts.dataDir, 'secret.key');
      const includeKey = !opts.keyFromEnv && existsSync(keyFile);
      if (includeKey) {
        warnings.push(
          'secret.key ist enthalten: Wer dieses Backup besitzt, kann alle gespeicherten API-Keys und Tokens entschlüsseln. ' +
            'Backup sicher aufbewahren oder VIBE_SECRET_KEY setzen.',
        );
      } else if (opts.keyFromEnv) {
        warnings.push('Der Schlüssel kommt aus VIBE_SECRET_KEY und ist nicht enthalten – für eine Wiederherstellung wird derselbe Wert benötigt.');
      }

      const contents = ['vibe.sqlite'];
      if (includeKey) contents.push('secret.key');
      if (opts.includeProjects) contents.push('projects/');
      const manifest: BackupManifest = {
        format: 'agentforge-backup',
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        appVersion: opts.version,
        contents,
        includesProjects: opts.includeProjects,
        includesSecretKey: includeKey,
        warnings,
        excludedDirs: opts.includeProjects ? [...BACKUP_EXCLUDED_DIRS] : [],
      };

      await addBuffer(w, 'manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
      await addFile(w, snapshot, 'vibe.sqlite', 0o600);
      if (includeKey) await addFile(w, keyFile, 'secret.key', 0o600);
      if (opts.includeProjects) {
        const projects = path.join(opts.dataDir, 'projects');
        if (existsSync(projects)) await addTree(w, projects, 'projects', opts.log);
      }
      pack.finalize();
    } catch (err) {
      opts.log?.warn(`Backup fehlgeschlagen: ${(err as Error).message}`);
      pack.destroy(err as Error);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  })();

  return out;
}

/** Adds an entry without a streamed body (buffer, directory, symlink) and waits until it is written. */
interface Writer {
  pack: tar.Pack;
  closed: Promise<never>;
}

function entryDone({ pack, closed }: Writer, header: TarHeader, body?: Buffer): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    const cb = (err?: Error | null) => (err ? reject(err) : resolve());
    if (body) pack.entry(header, body, cb);
    else pack.entry(header, cb);
  });
  return Promise.race([done, closed]);
}

function addBuffer(w: Writer, name: string, buf: Buffer, mode = 0o644) {
  return entryDone(w,{ name, size: buf.length, mode, mtime: new Date(), type: 'file' }, buf);
}

/** Yields exactly `size` bytes of `file`, zero-padding if it shrank while being read. */
async function* exactBytes(file: string, size: number) {
  let n = 0;
  if (size > 0) {
    for await (const chunk of createReadStream(file, { start: 0, end: size - 1 })) {
      n += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
  }
  if (n < size) yield Buffer.alloc(size - n);
}

async function addFile({ pack, closed }: Writer, file: string, name: string, mode?: number) {
  const st = await lstat(file);
  const header: TarHeader = { name, size: st.size, mode: mode ?? st.mode & 0o7777, mtime: st.mtime, type: 'file' };
  const done = new Promise<void>((resolve, reject) => {
    const entry = pack.entry(header, (err) => (err ? reject(err) : resolve()));
    pipeline(Readable.from(exactBytes(file, st.size)), entry).catch(reject);
  });
  await Promise.race([done, closed]);
}

async function addTree(pack: Writer, dir: string, prefix: string, log?: { warn: (m: string) => void }) {
  const st = await lstat(dir);
  await entryDone(pack, { name: prefix + '/', type: 'directory', mode: st.mode & 0o7777, mtime: st.mtime });
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch (err) {
    log?.warn(`Backup: ${dir} nicht lesbar: ${(err as Error).message}`);
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const rel = `${prefix}/${name}`;
    try {
      const s = await lstat(full);
      if (s.isDirectory()) {
        if (BACKUP_EXCLUDED_DIRS.has(name)) continue;
        await addTree(pack, full, rel, log);
      } else if (s.isSymbolicLink()) {
        await entryDone(pack, { name: rel, type: 'symlink', linkname: await readlink(full), mode: 0o777, mtime: s.mtime });
      } else if (s.isFile()) {
        await addFile(pack, full, rel);
      }
      // sockets, fifos, devices: skipped
    } catch (err) {
      // Files can vanish while a workspace is running; skip them instead of aborting the backup.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
}
