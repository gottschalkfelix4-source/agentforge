// Git (executed by wsd inside the workspace) and GitHub (executed by the app server).

export interface GitFileStatus {
  path: string;
  /** Original path for renames. */
  from?: string;
  /** Porcelain v1 XY codes: index (staged) and worktree status letters, ' ' = unmodified, '?' untracked. */
  index: string;
  worktree: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitBranches {
  current: string | null;
  local: string[];
  remote: string[];
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;
}

/** `cwd` is relative to /workspace (default "."), e.g. ".worktrees/task-12". */
export interface GitCwd { cwd?: string }

export interface GitHubStatus {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  scopes: string[];
  /** True when an OAuth client id is available for the device flow. */
  deviceFlowAvailable: boolean;
}

export interface GitHubDeviceStart {
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubDevicePoll {
  status: 'pending' | 'done' | 'expired' | 'denied' | 'error';
  login?: string;
  message?: string;
}

export interface GhRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string;
}

export type CiState = 'pending' | 'success' | 'failure' | 'neutral' | 'none';

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  head: string;
  base: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  ciState: CiState;
  mergeable: boolean | null;
}

export interface GhCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  htmlUrl: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  milestone: { number: number; title: string } | null;
  author: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  isPull: boolean;
}

export interface CreatePullRequest {
  title: string;
  body?: string;
  head: string;
  base?: string;
  draft?: boolean;
}
