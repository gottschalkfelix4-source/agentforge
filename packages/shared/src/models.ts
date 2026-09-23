// REST-level domain models shared by server and web.

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
  | 'gemini';

export interface Provider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  /** True when an API key is stored; the key itself is never sent to the browser. */
  hasKey: boolean;
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
  models?: string[];
  defaultModel?: string | null;
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
