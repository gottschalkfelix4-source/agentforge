// REST-level domain models shared by server and web.

import type { ApprovalPolicy } from './sessions.js';

export type WorkspaceStatus = 'none' | 'creating' | 'starting' | 'running' | 'stopped' | 'error';

export interface Project {
  id: string;
  name: string;
  slug: string;
  gitUrl: string | null;
  defaultBranch: string | null;
  /** Linked GitHub repository (Phase 3). */
  repoOwner: string | null;
  repoName: string | null;
  createdAt: string;
  archived: boolean;
}

export interface Workspace {
  id: string;
  projectId: string;
  containerId: string | null;
  image: string;
  status: WorkspaceStatus;
  statusMessage: string | null;
  cpuLimit: number | null;
  memLimitMb: number | null;
  lastSeenAt: string | null;
}

export interface ProjectWithWorkspace extends Project {
  workspace: Workspace | null;
}

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'openai_compat'
  | 'anthropic_compat'
  | 'ollama'
  /** Google Gemini API (Phase 6). */
  | 'gemini'
  /** ChatGPT Plus/Pro subscription, logged in once via OpenAI's device flow; tokens are managed by Agentforge. */
  | 'openai_chatgpt';

/** Account of a ChatGPT subscription provider (no tokens). */
export interface ChatGptAccount {
  email: string | null;
  /** plus | pro | team | … as reported by OpenAI. */
  planType: string | null;
}

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  /** True when an API key (or, for openai_chatgpt, a login) is stored; secrets are never sent to the browser. */
  hasKey: boolean;
  /** openai_chatgpt only: the logged-in account. */
  account?: ChatGptAccount | null;
  models: string[];
  defaultModel: string | null;
  createdAt: string;
}

export interface ProviderInput {
  kind: ProviderKind;
  name: string;
  baseUrl?: string | null;
  /** Omit to keep the existing key, empty string to remove it. */
  apiKey?: string;
  /** openai_chatgpt: handle of a finished ChatGPT login (POST /api/providers/chatgpt/device/*) to store. */
  chatgptLogin?: string;
  models?: string[];
  defaultModel?: string | null;
}

export interface ChatGptDeviceStart {
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface ChatGptDevicePoll {
  status: 'pending' | 'done' | 'expired' | 'error';
  account?: ChatGptAccount;
  message?: string;
}

export type AgentAuthMode = 'subscription' | 'provider';

export interface AgentProfile {
  id: string;
  agentKind: string;
  name: string;
  authMode: AgentAuthMode;
  providerId: string | null;
  model: string | null;
  extraArgs: string[];
  env: Record<string, string>;
  /** Freigaben preselected for chat sessions and task runs with this profile. */
  approvalPolicy: ApprovalPolicy;
  createdAt: string;
}

export interface AgentProfileInput {
  agentKind: string;
  name: string;
  authMode: AgentAuthMode;
  providerId?: string | null;
  model?: string | null;
  extraArgs?: string[];
  env?: Record<string, string>;
  approvalPolicy?: ApprovalPolicy;
}

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  command: string;
  args: string[];
  pid: number | null;
  exited: boolean;
  exitCode: number | null;
  createdAt: string;
}

export interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
}

export interface MeResponse {
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
  secretKeyFromEnv: boolean;
}

export interface ApiError {
  error: string;
  message: string;
}

// ---- REST request bodies -------------------------------------------------

export interface SetupRequest { setupToken: string; username: string; password: string }
export interface LoginRequest { username: string; password: string }

export interface CreateProjectRequest {
  name: string;
  /** Optional git URL to clone into the workspace on first start. */
  gitUrl?: string | null;
  /** Optional GitHub repo to link (cloned with the stored GitHub token). */
  repo?: { owner: string; name: string } | null;
}

export interface UpdateProjectRequest {
  name?: string;
  archived?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
}

export type CreateTerminalRequest =
  | { kind: 'shell'; cols?: number; rows?: number }
  | {
      kind: 'agent';
      agentId: string;
      /** 'run' starts the agent TUI; 'login' runs its subscription login command. */
      mode: 'run' | 'login';
      profileId?: string | null;
      cols?: number;
      rows?: number;
    };

export interface SystemInfo {
  previewMode: 'port' | 'subdomain';
  dockerOk: boolean;
  dockerError: string | null;
  workspaceImage: string;
  workspaceImagePresent: boolean;
  version: string;
}

export type WorkspaceAction = 'start' | 'stop' | 'restart' | 'recreate';
