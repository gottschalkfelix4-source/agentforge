import type { CiState, GhCheck, GhIssue, GhPull, GhRepo } from '@vibe/shared';

// Raw GitHub REST shapes (only the fields we use).
export interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  default_branch: string;
  clone_url: string;
  html_url: string;
  updated_at: string;
  pushed_at?: string | null;
}

export interface RawPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at?: string | null;
  merged?: boolean;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  mergeable?: boolean | null;
}

export interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: (string | { name?: string; color?: string })[];
  milestone: { number: number; title: string } | null;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

export interface RawCombinedStatus {
  state: 'pending' | 'success' | 'failure' | 'error';
  total_count: number;
  statuses: { context: string; state: 'pending' | 'success' | 'failure' | 'error'; target_url: string | null }[];
}

export interface RawCheckRuns {
  total_count: number;
  check_runs: { name: string; status: 'queued' | 'in_progress' | 'completed' | string; conclusion: string | null; html_url: string | null }[];
}

export const toRepo = (r: RawRepo): GhRepo => ({
  id: r.id,
  owner: r.owner.login,
  name: r.name,
  fullName: r.full_name,
  private: r.private,
  description: r.description,
  defaultBranch: r.default_branch,
  cloneUrl: r.clone_url,
  htmlUrl: r.html_url,
  updatedAt: r.pushed_at ?? r.updated_at,
});

export const toPull = (r: RawPull, ciState: CiState = 'none'): GhPull => ({
  number: r.number,
  title: r.title,
  body: r.body,
  state: r.merged_at || r.merged ? 'merged' : r.state,
  draft: !!r.draft,
  head: r.head.ref,
  base: r.base.ref,
  author: r.user?.login ?? 'ghost',
  htmlUrl: r.html_url,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ciState,
  mergeable: r.mergeable ?? null,
});

export const toIssue = (r: RawIssue): GhIssue => ({
  number: r.number,
  title: r.title,
  body: r.body,
  state: r.state,
  labels: r.labels.map((l) => (typeof l === 'string' ? { name: l, color: '888888' } : { name: l.name ?? '', color: l.color ?? '888888' })),
  milestone: r.milestone ? { number: r.milestone.number, title: r.milestone.title } : null,
  author: r.user?.login ?? 'ghost',
  htmlUrl: r.html_url,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  isPull: !!r.pull_request,
});

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error']);

/** Checks list = check runs + legacy commit statuses. */
export function toChecks(status: RawCombinedStatus | null, runs: RawCheckRuns | null): GhCheck[] {
  const out: GhCheck[] = [];
  for (const r of runs?.check_runs ?? []) {
    out.push({
      name: r.name,
      status: r.status === 'queued' || r.status === 'in_progress' || r.status === 'completed' ? r.status : 'queued',
      conclusion: r.conclusion,
      htmlUrl: r.html_url,
    });
  }
  for (const s of status?.statuses ?? []) {
    out.push({
      name: s.context,
      status: s.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: s.state === 'pending' ? null : s.state,
      htmlUrl: s.target_url,
    });
  }
  return out;
}

/** Aggregates check runs + commit statuses into a single CI state. */
export function combineCi(checks: GhCheck[]): CiState {
  if (checks.length === 0) return 'none';
  let pending = false;
  let success = false;
  for (const c of checks) {
    if (c.status !== 'completed') pending = true;
    else if (c.conclusion && FAILED.has(c.conclusion)) return 'failure';
    else if (c.conclusion === 'success') success = true;
  }
  if (pending) return 'pending';
  return success ? 'success' : 'neutral';
}
