import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialStore } from '../src/git-credential.js';
import { parseBranchHeader, parseBranches, parseCredentialInput, parseLog, parseStatusZ, parseWorktrees } from '../src/git-parse.js';
import { checkPathspecs, checkRefName, checkRemoteUrl, createGitModule } from '../src/git.js';

describe('status parsing', () => {
  it('parses branch headers', () => {
    expect(parseBranchHeader('## main...origin/main [ahead 2, behind 1]')).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
    expect(parseBranchHeader('## main...origin/main [behind 3]')).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 3 });
    expect(parseBranchHeader('## feat/x...origin/feat/x [gone]')).toEqual({ branch: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 0 });
    expect(parseBranchHeader('## main')).toEqual({ branch: 'main', upstream: null, ahead: 0, behind: 0 });
    expect(parseBranchHeader('## No commits yet on trunk')).toEqual({ branch: 'trunk', upstream: null, ahead: 0, behind: 0 });
    expect(parseBranchHeader('## Initial commit on master').branch).toBe('master');
    expect(parseBranchHeader('## HEAD (no branch)').branch).toBeNull();
  });

  it('parses porcelain v1 -z entries incl. renames, spaces and untracked', () => {
    const out = [
      '## main...origin/main [ahead 1]',
      'M  staged.ts',
      ' M unstaged file.ts',
      'MM both.ts',
      'R  new name.ts',
      'old name.ts',
      'A  added.ts',
      ' D deleted.ts',
      '?? untracked/ä.txt',
      '',
    ].join('\0');
    const s = parseStatusZ(out);
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.ahead).toBe(1);
    expect(s.files).toEqual([
      { path: 'staged.ts', index: 'M', worktree: ' ' },
      { path: 'unstaged file.ts', index: ' ', worktree: 'M' },
      { path: 'both.ts', index: 'M', worktree: 'M' },
      { path: 'new name.ts', from: 'old name.ts', index: 'R', worktree: ' ' },
      { path: 'added.ts', index: 'A', worktree: ' ' },
      { path: 'deleted.ts', index: ' ', worktree: 'D' },
      { path: 'untracked/ä.txt', index: '?', worktree: '?' },
    ]);
  });

  it('parses log, branches and worktrees', () => {
    const log = parseLog('a1\x1fa\x1fAnn\x1fann@x\x1f2024-01-01T00:00:00+00:00\x1ffirst\x1e\nb2\x1fb\x1fBob\x1fbob@x\x1f2024-01-02T00:00:00+00:00\x1fsecond: with \x1e');
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ sha: 'b2', shortSha: 'b', author: 'Bob', subject: 'second: with ' });
    expect(parseBranches('refs/heads/main\nrefs/heads/feat/a\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\n', 'main')).toEqual({
      current: 'main',
      local: ['main', 'feat/a'],
      remote: ['origin/main'],
    });
    const wt = parseWorktrees(
      'worktree /workspace\nHEAD abc\nbranch refs/heads/main\n\nworktree /workspace/.worktrees/t1\nHEAD def\ndetached\n\n',
      (abs) => (abs === '/workspace' ? '.' : abs.replace('/workspace/', '')),
    );
    expect(wt).toEqual([
      { path: '.', head: 'abc', branch: 'main' },
      { path: '.worktrees/t1', head: 'def', branch: null },
    ]);
  });
});

describe('path and name safety', () => {
  const root = path.resolve('/tmp/ws-root');
  it('accepts paths inside the workspace', () => {
    expect(checkPathspecs(root, root, ['a.ts', 'src/b c.ts', './x'])).toEqual(['a.ts', 'src/b c.ts', './x']);
    expect(checkPathspecs(root, path.join(root, 'sub'), ['../a.ts'])).toEqual(['../a.ts']);
  });
  it('rejects escapes, absolute paths and NUL', () => {
    expect(() => checkPathspecs(root, root, ['../etc/passwd'])).toThrow(/escapes/);
    expect(() => checkPathspecs(root, path.join(root, 'sub'), ['../../x'])).toThrow(/escapes/);
    expect(() => checkPathspecs(root, root, ['/etc/passwd'])).toThrow(/absolute/);
    expect(() => checkPathspecs(root, root, ['C:\\x'])).toThrow(/absolute/);
    expect(() => checkPathspecs(root, root, ['a\0b'])).toThrow(/NUL/);
    expect(() => checkPathspecs(root, root, [''])).toThrow();
    expect(() => checkPathspecs(root, root, 'a' as unknown)).toThrow();
  });
  it('rejects option injection in ref names and URLs', () => {
    expect(checkRefName('feat/x-1')).toBe('feat/x-1');
    expect(() => checkRefName('--upload-pack=evil')).toThrow();
    expect(() => checkRefName('a b')).toThrow();
    expect(() => checkRefName('a..b')).toThrow();
    expect(() => checkRemoteUrl('--upload-pack=x')).toThrow();
    expect(() => checkRemoteUrl('ext::sh -c evil')).toThrow();
    expect(checkRemoteUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
  });
});

describe('credential store', () => {
  it('answers get requests for known https hosts only', () => {
    const s = new CredentialStore();
    s.set('github.com', { username: 'x-access-token', token: 'tok' });
    expect(s.answer('protocol=https\nhost=github.com\n\n')).toBe('username=x-access-token\npassword=tok\n');
    expect(s.answer('protocol=https\nhost=GitHub.com:443\n')).toContain('password=tok');
    expect(s.answer('protocol=http\nhost=github.com\n')).toBe('');
    expect(s.answer('protocol=https\nhost=gitlab.com\n')).toBe('');
    s.clear('github.com');
    expect(s.answer('protocol=https\nhost=github.com\n')).toBe('');
    expect(parseCredentialInput('a=1\r\nb=x=y\n')).toEqual({ a: '1', b: 'x=y' });
  });
});

let hasGit = true;
try {
  execFileSync('git', ['--version']);
} catch {
  hasGit = false;
}

describe.skipIf(!hasGit)('git module (real git)', () => {
  let root: string;
  let home: string;
  const prevHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  let git: ReturnType<typeof createGitModule>['handlers'];
  let close: () => void;

  beforeAll(() => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-git-')));
    root = path.join(base, 'workspace');
    home = path.join(base, 'home');
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.WSD_CRED_SOCKET = path.join(base, 'cred', 'cred.sock');
    const mod = createGitModule({ root, notify: () => undefined });
    git = mod.handlers;
    close = mod.close;
  });

  afterAll(() => {
    close?.();
    Object.assign(process.env, prevHome);
    for (const [k, v] of Object.entries(prevHome)) if (v === undefined) delete process.env[k];
    delete process.env.WSD_CRED_SOCKET;
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('reports non-repos', async () => {
    expect((await git['git.status']({})).isRepo).toBe(false);
    expect(await git['git.worktree.list']({})).toEqual([]);
  });

  it('runs the basic workflow', async () => {
    await git['git.init']({ defaultBranch: 'main' });
    await git['git.identity.set']({ name: 'Test User', email: 'test@example.com' });
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    fs.writeFileSync(path.join(root, 'b c.txt'), 'x\n');

    let st = await git['git.status']({});
    expect(st.branch).toBe('main');
    expect(st.files.map((f) => [f.path, f.index])).toEqual(expect.arrayContaining([['a.txt', '?'], ['b c.txt', '?']]));
    expect((await git['git.diff']({ path: 'a.txt' })).diff).toContain('+hello');
    expect(await git['git.log']({})).toEqual([]);

    await git['git.stage']({ paths: ['a.txt'] });
    st = await git['git.status']({});
    expect(st.files.find((f) => f.path === 'a.txt')).toMatchObject({ index: 'A', worktree: ' ' });
    expect((await git['git.diff']({ staged: true })).diff).toContain('+hello');
    await git['git.unstage']({ paths: ['a.txt'] });
    expect((await git['git.status']({})).files.find((f) => f.path === 'a.txt')?.index).toBe('?');

    await git['git.stage']({ paths: [] });
    const { sha } = await git['git.commit']({ message: 'initial' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await git['git.log']({ limit: 5 });
    expect(log[0]).toMatchObject({ sha, subject: 'initial', author: 'Test User' });

    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(root, 'junk.txt'), 'junk\n');
    await git['git.discard']({ paths: ['a.txt', 'junk.txt'] });
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8').replace(/\r/g, '')).toBe('hello\n');
    expect(fs.existsSync(path.join(root, 'junk.txt'))).toBe(false);

    await git['git.checkout']({ branch: 'feat/x', create: true });
    const br = await git['git.branches']({});
    expect(br.current).toBe('feat/x');
    expect(br.local.sort()).toEqual(['feat/x', 'main']);
    await git['git.checkout']({ branch: 'main' });
    expect((await git['git.branches']({})).current).toBe('main');

    await expect(git['git.stage']({ paths: ['../outside'] })).rejects.toThrow(/escapes/);
    await expect(git['git.checkout']({ branch: '--orphan' })).rejects.toThrow();
  });

  it('manages worktrees and excludes .worktrees/', async () => {
    const wt = await git['git.worktree.add']({ path: '.worktrees/task-1', branch: 'task-1', base: 'main' });
    expect(wt).toMatchObject({ path: '.worktrees/task-1', branch: 'task-1' });
    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.worktrees/');
    expect((await git['git.status']({})).files).toEqual([]);
    const list = await git['git.worktree.list']({});
    expect(list.map((w) => w.path)).toEqual(['.', '.worktrees/task-1']);
    fs.writeFileSync(path.join(root, '.worktrees/task-1/new.txt'), 'n\n');
    const wst = await git['git.status']({ cwd: '.worktrees/task-1' });
    expect(wst.branch).toBe('task-1');
    expect(wst.files.map((f) => f.path)).toEqual(['new.txt']);
    await git['git.worktree.remove']({ path: '.worktrees/task-1', force: true });
    expect((await git['git.worktree.list']({})).map((w) => w.path)).toEqual(['.']);
  });

  it('sets and reads remotes', async () => {
    expect((await git['git.remote.get']({})).url).toBeNull();
    await git['git.remote.set']({ name: 'origin', url: 'https://github.com/a/b.git' });
    await git['git.remote.set']({ name: 'origin', url: 'https://github.com/a/c.git' });
    expect((await git['git.remote.get']({ name: 'origin' })).url).toBe('https://github.com/a/c.git');
  });
});
