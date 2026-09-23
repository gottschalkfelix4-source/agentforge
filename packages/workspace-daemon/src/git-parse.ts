import type { GitBranches, GitCommit, GitFileStatus, GitStatus, GitWorktree } from '@vibe/shared';

// Pure parsers for git CLI output (kept separate so they are unit-testable without git).

export interface BranchHeader {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Parses the `## ...` header line of `git status --porcelain=v1 --branch` (without the leading "## "). */
export function parseBranchHeader(line: string): BranchHeader {
  const out: BranchHeader = { branch: null, upstream: null, ahead: 0, behind: 0 };
  let s = line.replace(/^## /, '');
  // Unborn branch: "No commits yet on main" (git >= 2.28) / "Initial commit on main" (older).
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(s);
  if (unborn) {
    out.branch = unborn[1]!;
    return out;
  }
  if (s.startsWith('HEAD (no branch)')) return out;
  const track = /\s\[([^\]]*)\]$/.exec(s);
  if (track) {
    s = s.slice(0, track.index);
    for (const part of track[1]!.split(',').map((p) => p.trim())) {
      const m = /^(ahead|behind) (\d+)$/.exec(part);
      if (m) out[m[1] as 'ahead' | 'behind'] = Number(m[2]);
    }
  }
  const dots = s.indexOf('...');
  if (dots >= 0) {
    out.branch = s.slice(0, dots);
    out.upstream = s.slice(dots + 3) || null;
  } else {
    out.branch = s || null;
  }
  return out;
}

/**
 * Parses `git status --porcelain=v1 -z --branch` output.
 * Entries are NUL-separated "XY path"; renames/copies are followed by an extra entry with the source path.
 */
export function parseStatusZ(out: string): GitStatus {
  const status: GitStatus = { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    if (entry.startsWith('## ')) {
      Object.assign(status, parseBranchHeader(entry));
      continue;
    }
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const x = entry[0]!;
    const y = entry[1]!;
    if (x === '!') continue; // ignored files
    const file: GitFileStatus = { path: entry.slice(3), index: x === '?' ? '?' : x, worktree: y };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const from = parts[i + 1];
      if (from !== undefined) {
        file.from = from;
        i++;
      }
    }
    status.files.push(file);
  }
  return status;
}

export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';

export function parseLog(out: string): GitCommit[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha = '', shortSha = '', author = '', email = '', date = '', subject = ''] = r.split('\x1f');
      return { sha, shortSha, author, email, date, subject };
    });
}

/** Parses `git for-each-ref --format=%(refname) refs/heads refs/remotes`. */
export function parseBranches(refs: string, current: string | null): GitBranches {
  const local: string[] = [];
  const remote: string[] = [];
  for (const ref of refs.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      if (!name.endsWith('/HEAD')) remote.push(name);
    }
  }
  return { current, local, remote };
}

/**
 * Parses `git worktree list --porcelain`. `toWire` converts git's absolute paths into
 * workspace-relative wire paths.
 */
export function parseWorktrees(out: string, toWire: (abs: string) => string): GitWorktree[] {
  const result: GitWorktree[] = [];
  let cur: { path?: string; head?: string; branch?: string | null; bare?: boolean } = {};
  const flush = () => {
    if (cur.path && !cur.bare) result.push({ path: toWire(cur.path), head: cur.head ?? '', branch: cur.branch ?? null });
    cur = {};
  };
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur.path) flush();
      cur.path = val;
    } else if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.branch = null;
    else if (key === 'bare') cur.bare = true;
  }
  flush();
  return result;
}

/** Git credential protocol: "key=value" lines → object. */
export function parseCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const l = line.replace(/\r$/, '');
    const eq = l.indexOf('=');
    if (eq > 0) out[l.slice(0, eq)] = l.slice(eq + 1);
  }
  return out;
}
