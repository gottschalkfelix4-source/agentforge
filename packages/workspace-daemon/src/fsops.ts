import fs from 'node:fs/promises';
import path from 'node:path';
import type { FsEntry, FsReadResult, FsWriteParams } from '@vibe/shared';
import { WsdError, invalidParams } from './errors.js';
import { relativeWire, resolveSafe } from './paths.js';

export const TEXT_LIMIT = 5 * 1024 * 1024;
export const READ_LIMIT = 20 * 1024 * 1024;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Returns the decoded string if the buffer is valid UTF-8 text without NUL bytes. */
export function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return utf8Decoder.decode(buf);
  } catch {
    return null;
  }
}

export class FsOps {
  constructor(private readonly root: string) {}

  async list(p: unknown): Promise<FsEntry[]> {
    const dir = await resolveSafe(this.root, p ?? '.');
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d): Promise<FsEntry> => {
        const abs = path.join(dir, d.name);
        let size = 0;
        let type: FsEntry['type'] = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file';
        try {
          const st = await fs.lstat(abs);
          size = st.isFile() ? st.size : 0;
          type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file';
        } catch {
          /* vanished between readdir and lstat */
        }
        return { name: d.name, path: relativeWire(this.root, abs), type, size };
      }),
    );
    return entries.sort((a, b) => {
      const ad = a.type === 'dir' ? 0 : 1;
      const bd = b.type === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
  }

  async read(p: unknown): Promise<FsReadResult> {
    const abs = await resolveSafe(this.root, p);
    const st = await fs.stat(abs);
    if (st.isDirectory()) throw new WsdError('EISDIR', `is a directory: ${String(p)}`);
    if (st.size > READ_LIMIT) throw new WsdError('EFBIG', `file too large (${st.size} bytes, limit ${READ_LIMIT})`);
    const buf = await fs.readFile(abs);
    const wirePath = relativeWire(this.root, abs);
    if (buf.length < TEXT_LIMIT) {
      const text = decodeText(buf);
      if (text !== null) return { path: wirePath, content: text, encoding: 'utf8', size: buf.length };
    }
    return { path: wirePath, content: buf.toString('base64'), encoding: 'base64', size: buf.length };
  }

  async write(params: FsWriteParams): Promise<void> {
    if (typeof params.content !== 'string') throw invalidParams('content must be a string');
    const abs = await resolveSafe(this.root, params.path);
    if (abs === path.resolve(this.root)) throw new WsdError('EISDIR', 'cannot write to workspace root');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const data = params.encoding === 'base64' ? Buffer.from(params.content, 'base64') : params.content;
    await fs.writeFile(abs, data);
  }

  async mkdir(p: unknown): Promise<void> {
    const abs = await resolveSafe(this.root, p);
    await fs.mkdir(abs, { recursive: true });
  }

  async delete(p: unknown): Promise<void> {
    const abs = await resolveSafe(this.root, p, { followFinal: false });
    if (abs === path.resolve(this.root)) throw new WsdError('EACCES', 'refusing to delete workspace root');
    await fs.lstat(abs); // ENOENT if missing
    await fs.rm(abs, { recursive: true, force: false });
  }

  async rename(from: unknown, to: unknown): Promise<void> {
    const src = await resolveSafe(this.root, from, { followFinal: false });
    const dst = await resolveSafe(this.root, to, { followFinal: false });
    const rootAbs = path.resolve(this.root);
    if (src === rootAbs || dst === rootAbs) throw new WsdError('EACCES', 'cannot rename workspace root');
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  }
}
