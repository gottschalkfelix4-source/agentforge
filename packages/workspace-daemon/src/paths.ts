import fs from 'node:fs/promises';
import path from 'node:path';
import { WsdError } from './errors.js';

/** Converts a native path to the forward-slash form used on the wire. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Lexically resolves a client-supplied path against the workspace root.
 * Accepts relative paths ("src/a.ts", ".", ""), paths with a leading slash
 * ("/src/a.ts" = relative to root) and absolute paths already under the root.
 * Throws EACCES-style errors for anything escaping the root.
 */
export function resolveLexical(root: string, input: unknown): string {
  if (typeof input !== 'string') throw new WsdError('EINVAL', 'path must be a string');
  if (input.includes('\0')) throw new WsdError('EINVAL', 'path contains NUL byte');
  const absRoot = path.resolve(root);
  let p = input.replace(/\\/g, '/');
  const rootPosix = toPosix(absRoot);
  if (p === rootPosix || p.startsWith(rootPosix.endsWith('/') ? rootPosix : rootPosix + '/')) {
    p = p.slice(rootPosix.length);
  }
  p = p.replace(/^\/+/, '');
  // Reject Windows drive-absolute input on any platform.
  if (/^[a-zA-Z]:/.test(p)) throw new WsdError('EACCES', `path escapes workspace: ${input}`);
  const resolved = path.resolve(absRoot, p || '.');
  if (!isInside(absRoot, resolved)) throw new WsdError('EACCES', `path escapes workspace: ${input}`);
  return resolved;
}

/** Relative wire path of an absolute path inside root ("" for the root → "."). */
export function relativeWire(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), abs);
  return rel === '' ? '.' : toPosix(rel);
}

async function realpathOfNearestExisting(p: string): Promise<string> {
  let cur = p;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      suffix.push(path.basename(cur));
      cur = parent;
    }
  }
}

export interface ResolveOptions {
  /**
   * If true (default) the final path component is followed when it is a symlink
   * (read/write/list). If false only the parent directory is realpath-checked
   * (delete/rename operate on the link itself).
   */
  followFinal?: boolean;
}

/**
 * Resolves a path and additionally verifies (via realpath of the nearest
 * existing ancestor) that symlinks do not lead outside the root.
 */
export async function resolveSafe(root: string, input: unknown, opts: ResolveOptions = {}): Promise<string> {
  const followFinal = opts.followFinal ?? true;
  const lexical = resolveLexical(root, input);
  const realRoot = await fs.realpath(path.resolve(root));
  const absRoot = path.resolve(root);
  const target = followFinal || lexical === absRoot ? lexical : path.dirname(lexical);
  const real = await realpathOfNearestExisting(target);
  if (!isInside(realRoot, real)) throw new WsdError('EACCES', `path escapes workspace via symlink: ${String(input)}`);
  return lexical;
}
