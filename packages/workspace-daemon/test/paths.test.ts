import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relativeWire, resolveLexical, resolveSafe } from '../src/paths.js';
import { FsOps, decodeText } from '../src/fsops.js';

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-test-')));
  root = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export {}');
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

function trySymlink(target: string, link: string, type: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, link, type === 'dir' ? 'junction' : 'file');
    return true;
  } catch {
    return false; // Windows without symlink privilege
  }
}

describe('resolveLexical', () => {
  it('resolves relative paths inside the root', () => {
    expect(resolveLexical(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveLexical(root, '.')).toBe(root);
    expect(resolveLexical(root, '')).toBe(root);
    expect(resolveLexical(root, './src/../src')).toBe(path.join(root, 'src'));
  });

  it('treats a leading slash as relative to the root', () => {
    expect(resolveLexical(root, '/src')).toBe(path.join(root, 'src'));
  });

  it('accepts absolute paths already under the root', () => {
    expect(resolveLexical(root, path.join(root, 'src'))).toBe(path.join(root, 'src'));
  });

  it('rejects traversal', () => {
    for (const bad of ['..', '../outside', 'src/../../outside', '/../etc/passwd', '..\outside', 'C:/Windows']) {
      expect(() => resolveLexical(root, bad), bad).toThrow(/escapes/);
    }
  });

  it('rejects a sibling dir sharing the root prefix', () => {
    expect(() => resolveLexical(root, '../workspace-evil/x')).toThrow(/escapes/);
  });

  it('rejects non-strings and NUL bytes', () => {
    expect(() => resolveLexical(root, 42)).toThrow();
    expect(() => resolveLexical(root, 'a\0b')).toThrow();
  });

  it('formats wire paths with forward slashes', () => {
    expect(relativeWire(root, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(relativeWire(root, root)).toBe('.');
  });
});

describe('resolveSafe (symlinks)', () => {
  it('allows non-existent nested paths inside root', async () => {
    await expect(resolveSafe(root, 'new/dir/file.txt')).resolves.toBe(path.join(root, 'new', 'dir', 'file.txt'));
  });

  it('rejects writes through a symlinked directory escaping the root', async () => {
    const link = path.join(root, 'escape');
    if (!trySymlink(outside, link, 'dir')) return;
    await expect(resolveSafe(root, 'escape/secret.txt')).rejects.toThrow(/symlink/);
    await expect(resolveSafe(root, 'escape/new/file.txt')).rejects.toThrow(/symlink/);
    // The link itself may be deleted (followFinal=false checks the parent only).
    await expect(resolveSafe(root, 'escape', { followFinal: false })).resolves.toBe(link);
    const ops = new FsOps(root);
    await expect(ops.write({ path: 'escape/pwn.txt', content: 'x' })).rejects.toThrow();
    expect(fs.existsSync(path.join(outside, 'pwn.txt'))).toBe(false);
    await ops.delete('escape');
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true);
  });
});

describe('FsOps', () => {
  it('lists dirs first and reads/writes files', async () => {
    const ops = new FsOps(root);
    await ops.write({ path: 'b/c/new.txt', content: 'héllo' });
    await ops.write({ path: 'bin.dat', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' });
    const entries = await ops.list('.');
    const firstFile = entries.findIndex((e) => e.type !== 'dir');
    expect(entries.slice(0, firstFile).every((e) => e.type === 'dir')).toBe(true);
    expect(entries.find((e) => e.name === 'b')?.path).toBe('b');
    const text = await ops.read('b/c/new.txt');
    expect(text).toMatchObject({ path: 'b/c/new.txt', encoding: 'utf8', content: 'héllo' });
    const bin = await ops.read('bin.dat');
    expect(bin.encoding).toBe('base64');
    expect(Buffer.from(bin.content, 'base64')).toEqual(Buffer.from([0, 1, 2, 255]));
    await ops.rename('b/c/new.txt', 'moved/x.txt');
    expect(fs.existsSync(path.join(root, 'moved', 'x.txt'))).toBe(true);
    await ops.delete('b');
    expect(fs.existsSync(path.join(root, 'b'))).toBe(false);
    await expect(ops.delete('.')).rejects.toThrow();
    await expect(ops.read('../outside/secret.txt')).rejects.toThrow(/escapes/);
  });

  it('decodeText detects binary', () => {
    expect(decodeText(Buffer.from('ok'))).toBe('ok');
    expect(decodeText(Buffer.from([0xc3, 0x28]))).toBeNull();
    expect(decodeText(Buffer.from([0x61, 0x00]))).toBeNull();
  });
});
