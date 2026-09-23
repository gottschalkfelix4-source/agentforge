import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitStatus, GitWorktree, WsdMethod } from '@vibe/shared';
import { PRIVATE_ENV_KEYS } from './config.js';
import { WsdError, invalidParams } from './errors.js';
import { CredentialStore, startCredentialServer } from './git-credential.js';
import { LOG_FORMAT, parseBranches, parseLog, parseStatusZ, parseWorktrees } from './git-parse.js';
import type { ModuleHandlers, WsdContext } from './module.js';
import { relativeWire, resolveSafe } from './paths.js';

// Phase 3 – git operations (git CLI via execFile, never a shell) and the in-memory credential helper.
export type GitMethod = Extract<WsdMethod, `git.${string}`>;

const DEFAULT_TIMEOUT = 60_000;
const NETWORK_TIMEOUT = 10 * 60_000;
const CLONE_TIMEOUT = 30 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const DIFF_LIMIT = 2 * 1024 * 1024;
const MAX_STATUS_FILES = 5000;
const WORKTREE_DIR = '.worktrees';

interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Exit codes that are not errors (default [0]). */
  okCodes?: number[];
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PRIVATE_ENV_KEYS.includes(k)) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  env.LANG = 'C';
  return env;
}

export function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
  const ok = opts.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env: gitEnv(), timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const code = e ? (typeof e.code === 'number' ? e.code : -1) : 0;
        if (!e || ok.includes(code)) {
          resolve({ stdout, stderr, code });
          return;
        }
        if (e.code === 'ENOENT') {
          reject(new WsdError('ENOENT', 'git ist im Workspace nicht installiert'));
          return;
        }
        const reason = e.killed ? 'Zeitüberschreitung' : (stderr || stdout).trim() || e.message;
        reject(new WsdError('EGIT', `git ${args.find((a) => !a.startsWith('-')) ?? ''}: ${reason}`));
      },
    );
  });
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validates client-supplied pathspecs relative to `dir` (which lies inside `root`). Rejects
 * absolute paths, NUL bytes and anything escaping the workspace root. Returns the paths unchanged
 * (git is run with --literal-pathspecs, so no pathspec magic is interpreted).
 */
export function checkPathspecs(root: string, dir: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) throw invalidParams('paths must be an array');
  const absRoot = path.resolve(root);
  return paths.map((p) => {
    if (typeof p !== 'string' || !p) throw invalidParams('paths must be non-empty strings');
    if (p.includes('\0')) throw new WsdError('EINVAL', 'path contains NUL byte');
    if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) {
      throw new WsdError('EACCES', `absolute paths are not allowed: ${p}`);
    }
    if (!isInside(absRoot, path.resolve(dir, p))) throw new WsdError('EACCES', `path escapes workspace: ${p}`);
    return p;
  });
}

/** Branch/ref/remote names: no option injection, no whitespace or control characters. */
export function checkRefName(v: unknown, what = 'branch'): string {
  if (typeof v !== 'string' || !v.trim()) throw invalidParams(`${what} must be a non-empty string`);
  // eslint-disable-next-line no-control-regex
  if (v.startsWith('-') || /[\s\x00-\x1f\x7f~^:?*[\\]/.test(v) || v.includes('..')) {
    throw new WsdError('EINVAL', `ungültiger Name: ${v}`);
  }
  return v;
}

export function checkRemoteName(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) throw new WsdError('EINVAL', `ungültiger Remote-Name: ${String(v)}`);
  return v;
}

export function checkRemoteUrl(v: unknown): string {
  if (typeof v !== 'string' || !/^(https?:\/\/|ssh:\/\/|git@|file:\/\/)\S+$/.test(v)) {
    throw new WsdError('EINVAL', 'ungültige Git-URL (erlaubt: https://, ssh://, git@…, file://)');
  }
  return v;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw invalidParams(`${name} must be a non-empty string`);
  return v;
}

export function createGitModule(ctx: WsdContext): { handlers: ModuleHandlers<GitMethod>; close: () => void } {
  const root = path.resolve(ctx.root);
  const creds = new CredentialStore();
  const credServer = startCredentialServer(creds);

  const dirOf = async (cwd: unknown): Promise<string> => {
    const dir = await resolveSafe(root, cwd ?? '.');
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new WsdError('ENOENT', `Verzeichnis existiert nicht: ${String(cwd ?? '.')}`);
    return dir;
  };

  const run = (args: string[], cwd: string, extra: Omit<RunOptions, 'cwd'> = {}) => runGit(args, { cwd, ...extra });

  const topLevel = async (dir: string): Promise<string> => {
    const r = await run(['rev-parse', '--show-toplevel'], dir);
    const top = path.resolve(r.stdout.trim());
    if (!isInside(root, top)) throw new WsdError('EACCES', 'Repository liegt außerhalb des Workspace');
    return top;
  };

  const hasHead = async (dir: string) => (await run(['rev-parse', '--verify', '-q', 'HEAD'], dir, { okCodes: [0, 1, 128] })).code === 0;

  const currentBranch = async (dir: string): Promise<string | null> => {
    const r = await run(['symbolic-ref', '--short', '-q', 'HEAD'], dir, { okCodes: [0, 1] });
    return r.code === 0 ? r.stdout.trim() || null : null;
  };

  const status = async (dir: string): Promise<GitStatus> => {
    const r = await run(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], dir, { okCodes: [0, 128] });
    if (r.code !== 0) {
      if (/not a git repository/i.test(r.stderr)) return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
      throw new WsdError('EGIT', `git status: ${r.stderr.trim()}`);
    }
    const s = parseStatusZ(r.stdout);
    if (s.files.length > MAX_STATUS_FILES) s.files = s.files.slice(0, MAX_STATUS_FILES);
    return s;
  };

  /** Makes sure `.worktrees/` is ignored locally (never touches the tracked .gitignore). */
  const ensureWorktreeExclude = async (dir: string) => {
    const r = await run(['rev-parse', '--git-common-dir'], dir, { okCodes: [0, 128] });
    if (r.code !== 0) return;
    const common = path.resolve(dir, r.stdout.trim());
    const file = path.join(common, 'info', 'exclude');
    const cur = await fs.readFile(file, 'utf8').catch(() => '');
    if (cur.split(/\r?\n/).some((l) => l.trim() === `/${WORKTREE_DIR}/` || l.trim() === `${WORKTREE_DIR}/`)) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}/${WORKTREE_DIR}/\n`);
  };

  const worktreeList = async (): Promise<GitWorktree[]> => {
    const r = await run(['worktree', 'list', '--porcelain'], root, { okCodes: [0, 128] });
    if (r.code !== 0) return [];
    return parseWorktrees(r.stdout, (abs) => {
      const p = path.resolve(abs);
      return isInside(root, p) ? relativeWire(root, p) : abs;
    });
  };

  const identityArgs = async (dir: string): Promise<string[]> => {
    const email = await run(['config', 'user.email'], dir, { okCodes: [0, 1] });
    return email.code === 0 && email.stdout.trim() ? [] : ['-c', 'user.name=Agentforge', '-c', 'user.email=agentforge@users.noreply.localhost'];
  };

  const handlers: ModuleHandlers<GitMethod> = {
    'git.status': async (p) => status(await dirOf(p.cwd)),

    'git.diff': async (p) => {
      const dir = await dirOf(p.cwd);
      const top = await topLevel(dir);
      const args = ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff'];
      if (p.staged) args.push('--cached');
      let out: string;
      if (p.path) {
        const [file] = checkPathspecs(root, top, [p.path]);
        const tracked = await run(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file!], top, { okCodes: [0, 1] });
        if (!p.staged && tracked.code !== 0) {
          // Untracked file: show it as an addition.
          const r = await run(['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file!], top, { okCodes: [0, 1] });
          out = r.stdout;
        } else {
          out = (await run([...args, '--', file!], top)).stdout;
        }
      } else {
        out = (await run(args, top)).stdout;
      }
      if (out.length > DIFF_LIMIT) out = `${out.slice(0, DIFF_LIMIT)}\n\n… (Diff gekürzt)\n`;
      return { diff: out };
    },

    'git.stage': async (p) => {
      const dir = await dirOf(p.cwd);
      const top = await topLevel(dir);
      const paths = checkPathspecs(root, top, p.paths ?? []);
      await run(paths.length ? ['--literal-pathspecs', 'add', '-A', '--', ...paths] : ['add', '-A'], top);
      return { ok: true };
    },

    'git.unstage': async (p) => {
      const dir = await dirOf(p.cwd);
      const top = await topLevel(dir);
      const paths = checkPathspecs(root, top, p.paths ?? []);
      if (await hasHead(top)) {
        await run(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...paths], top, { okCodes: [0, 1] });
      } else {
        await run(['--literal-pathspecs', 'rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...(paths.length ? paths : ['.'])], top);
      }
      return { ok: true };
    },

    'git.discard': async (p) => {
      const dir = await dirOf(p.cwd);
      const top = await topLevel(dir);
      const requested = checkPathspecs(root, top, p.paths ?? []);
      const st = await status(top);
      const untrackedSet = new Set(st.files.filter((f) => f.index === '?').map((f) => f.path));
      const changed = st.files.filter((f) => f.index !== '?' && f.worktree !== ' ').map((f) => f.path);
      const targets = requested.length ? requested : [...untrackedSet, ...changed];
      const untracked = targets.filter((t) => untrackedSet.has(t));
      const tracked = targets.filter((t) => !untrackedSet.has(t));
      if (untracked.length) await run(['--literal-pathspecs', 'clean', '-f', '-d', '-q', '--', ...untracked], top);
      if (tracked.length) await run(['--literal-pathspecs', 'checkout', '-q', '--', ...tracked], top);
      return { ok: true };
    },

    'git.commit': async (p) => {
      const dir = await dirOf(p.cwd);
      const message = str(p.message, 'message');
      if (!message.trim()) throw invalidParams('message must not be empty');
      await run([...(await identityArgs(dir)), 'commit', '-q', ...(p.all ? ['-a'] : []), '-m', message], dir);
      const sha = (await run(['rev-parse', 'HEAD'], dir)).stdout.trim();
      return { sha };
    },

    'git.push': async (p) => {
      const dir = await dirOf(p.cwd);
      const remote = checkRemoteName(p.remote ?? 'origin');
      const branch = p.branch ? checkRefName(p.branch) : await currentBranch(dir);
      if (!branch) throw new WsdError('EGIT', 'Kein Branch ausgecheckt (detached HEAD)');
      let setUpstream = p.setUpstream;
      if (setUpstream === undefined) {
        const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir, { okCodes: [0, 128] });
        setUpstream = up.code !== 0;
      }
      const args = ['push'];
      if (setUpstream) args.push('--set-upstream');
      if (p.force) args.push('--force-with-lease');
      args.push(remote, branch);
      const r = await run(args, dir, { timeoutMs: NETWORK_TIMEOUT });
      return { output: `${r.stdout}${r.stderr}`.trim() };
    },

    'git.pull': async (p) => {
      const dir = await dirOf(p.cwd);
      const args = ['pull', '--no-edit', '--no-rebase'];
      if (p.remote) args.push(checkRemoteName(p.remote));
      if (p.branch) args.push(checkRefName(p.branch));
      const r = await run(args, dir, { timeoutMs: NETWORK_TIMEOUT });
      return { output: `${r.stdout}${r.stderr}`.trim() };
    },

    'git.fetch': async (p) => {
      const dir = await dirOf(p.cwd);
      const args = ['fetch', '--prune', ...(p.remote ? [checkRemoteName(p.remote)] : ['--all'])];
      const r = await run(args, dir, { timeoutMs: NETWORK_TIMEOUT });
      return { output: `${r.stdout}${r.stderr}`.trim() };
    },

    'git.branches': async (p) => {
      const dir = await dirOf(p.cwd);
      const current = await currentBranch(dir);
      const refs = await run(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], dir);
      return parseBranches(refs.stdout, current);
    },

    'git.checkout': async (p) => {
      const dir = await dirOf(p.cwd);
      const branch = checkRefName(p.branch);
      if (p.create) {
        await run(['check-ref-format', '--branch', branch], dir);
        const args = ['checkout', '-q', '-b', branch];
        if (p.startPoint) args.push(checkRefName(p.startPoint, 'startPoint'));
        await run(args, dir);
        return { ok: true };
      }
      const local = await run(['show-ref', '--verify', '-q', `refs/heads/${branch}`], dir, { okCodes: [0, 1, 128] });
      if (local.code !== 0) {
        const remoteRef = await run(['show-ref', '--verify', '-q', `refs/remotes/${branch}`], dir, { okCodes: [0, 1, 128] });
        if (remoteRef.code === 0 && branch.includes('/')) {
          const localName = branch.slice(branch.indexOf('/') + 1);
          const exists = await run(['show-ref', '--verify', '-q', `refs/heads/${localName}`], dir, { okCodes: [0, 1, 128] });
          await run(exists.code === 0 ? ['checkout', '-q', localName] : ['checkout', '-q', '-b', localName, '--track', branch], dir);
          return { ok: true };
        }
      }
      await run(['checkout', '-q', branch, '--'], dir);
      return { ok: true };
    },

    'git.log': async (p) => {
      const dir = await dirOf(p.cwd);
      const limit = Math.min(Math.max(Math.trunc(Number(p.limit ?? 50)) || 50, 1), 500);
      const ref = p.ref ? checkRefName(p.ref, 'ref') : null;
      if (!ref && !(await hasHead(dir))) return [];
      const r = await run(['log', `-n${limit}`, `--format=${LOG_FORMAT}`, ...(ref ? [ref] : []), '--'], dir);
      return parseLog(r.stdout);
    },

    'git.init': async (p) => {
      const dir = await dirOf(p.cwd);
      const branch = checkRefName(p.defaultBranch ?? 'main');
      await run(['init', '-q', '-b', branch], dir);
      await ensureWorktreeExclude(dir);
      return { ok: true };
    },

    'git.clone': async (p) => {
      const url = checkRemoteUrl(p.url);
      const entries = (await fs.readdir(root)).filter((n) => n !== 'lost+found');
      if (entries.length) throw new WsdError('EEXIST', 'Workspace ist nicht leer – Klonen nicht möglich');
      await run(['clone', '--progress', '--', url, '.'], root, { timeoutMs: CLONE_TIMEOUT });
      await ensureWorktreeExclude(root);
      return { ok: true };
    },

    'git.remote.set': async (p) => {
      const dir = await dirOf(p.cwd);
      const name = checkRemoteName(p.name);
      const url = checkRemoteUrl(p.url);
      const exists = await run(['remote', 'get-url', name], dir, { okCodes: [0, 2, 128] });
      await run(exists.code === 0 ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url], dir);
      return { ok: true };
    },

    'git.remote.get': async (p) => {
      const dir = await dirOf(p.cwd);
      const name = checkRemoteName(p.name ?? 'origin');
      const r = await run(['remote', 'get-url', name], dir, { okCodes: [0, 2, 128] });
      return { url: r.code === 0 ? r.stdout.trim() || null : null };
    },

    'git.worktree.add': async (p) => {
      const rel = str(p.path, 'path');
      const abs = await resolveSafe(root, rel);
      if (abs === root) throw new WsdError('EINVAL', 'Worktree-Pfad darf nicht der Workspace sein');
      const branch = checkRefName(p.branch);
      await run(['check-ref-format', '--branch', branch], root);
      const existing = await fs.readdir(abs).catch(() => null);
      if (existing && existing.length) throw new WsdError('EEXIST', `Verzeichnis existiert bereits: ${rel}`);
      await ensureWorktreeExclude(root);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const branchExists = (await run(['show-ref', '--verify', '-q', `refs/heads/${branch}`], root, { okCodes: [0, 1, 128] })).code === 0;
      const args = branchExists
        ? ['worktree', 'add', '-q', abs, branch]
        : ['worktree', 'add', '-q', '-b', branch, abs, ...(p.base ? [checkRefName(p.base, 'base')] : [])];
      await run(args, root);
      const wire = relativeWire(root, abs);
      const wt = (await worktreeList()).find((w) => w.path === wire);
      return wt ?? { path: wire, branch, head: '' };
    },

    'git.worktree.remove': async (p) => {
      const abs = await resolveSafe(root, str(p.path, 'path'));
      if (abs === root) throw new WsdError('EINVAL', 'Der Haupt-Worktree kann nicht entfernt werden');
      await run(['worktree', 'remove', ...(p.force ? ['--force'] : []), abs], root);
      await run(['worktree', 'prune'], root, { okCodes: [0, 128] });
      return { ok: true };
    },

    'git.worktree.list': async () => worktreeList(),

    'git.credentials.set': async (p) => {
      const host = str(p.host, 'host');
      if ('clear' in p && p.clear) creds.clear(host);
      else {
        const c = p as { username: string; token: string };
        if (/[\r\n]/.test(`${c.username}${c.token}`)) throw invalidParams('credentials must not contain newlines');
        creds.set(host, { username: str(c.username, 'username'), token: str(c.token, 'token') });
      }
      return { ok: true };
    },

    'git.identity.set': async (p) => {
      const name = str(p.name, 'name');
      const email = str(p.email, 'email');
      if (/[\r\n]/.test(name + email)) throw invalidParams('identity must not contain newlines');
      await run(['config', '--global', 'user.name', name], root);
      await run(['config', '--global', 'user.email', email], root);
      return { ok: true };
    },
  };

  return { handlers, close: () => credServer?.close() };
}
