import type {
  AgentManifest,
  AgentProfile,
  AgentProfileInput,
  ChatGptDevicePoll,
  ChatGptDeviceStart,
  CreateProjectRequest,
  CreateTerminalRequest,
  FsEntry,
  FsReadResult,
  ListeningPort,
  LoginRequest,
  MeResponse,
  ProjectWithWorkspace,
  Provider,
  ProviderInput,
  SetupRequest,
  SystemInfo,
  TerminalInfo,
  UpdateProjectRequest,
  Workspace,
  WorkspaceAction,
} from '@vibe/shared';

export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  onUnauthorized = fn;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Do not trigger the global 401 → login redirect. */
  skipAuthRedirect?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  let url = `/api${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Vibe'] = '1';
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, credentials: 'include' });
  } catch {
    throw new ApiRequestError(0, 'network', 'Server nicht erreichbar');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as { error?: string; message?: string };
    const message = obj.message || obj.error || (typeof data === 'string' && data) || `HTTP ${res.status}`;
    const err = new ApiRequestError(res.status, obj.error ?? `http_${res.status}`, message);
    if (res.status === 401 && !opts.skipAuthRedirect) onUnauthorized?.();
    throw err;
  }
  return data as T;
}

type Ok = { ok: true };
const p = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const api = {
  // auth
  me: () => request<MeResponse>('/me', { skipAuthRedirect: true }),
  setup: (body: SetupRequest) => request<MeResponse>('/auth/setup', { method: 'POST', body, skipAuthRedirect: true }),
  login: (body: LoginRequest) => request<MeResponse>('/auth/login', { method: 'POST', body, skipAuthRedirect: true }),
  logout: () => request<Ok>('/auth/logout', { method: 'POST', skipAuthRedirect: true }),

  // system
  system: () => request<SystemInfo>('/system'),
  agents: () => request<AgentManifest[]>('/agents'),

  // projects
  projects: () => request<ProjectWithWorkspace[]>('/projects'),
  project: (id: string) => request<ProjectWithWorkspace>(p(id)),
  createProject: (body: CreateProjectRequest) => request<ProjectWithWorkspace>('/projects', { method: 'POST', body }),
  updateProject: (id: string, body: UpdateProjectRequest) =>
    request<ProjectWithWorkspace>(p(id), { method: 'PATCH', body }),
  deleteProject: (id: string, deleteFiles: boolean) =>
    request<Ok>(p(id), { method: 'DELETE', query: { deleteFiles: deleteFiles ? 1 : undefined } }),
  workspaceAction: (id: string, action: WorkspaceAction) =>
    request<Workspace>(`${p(id)}/workspace/${action}`, { method: 'POST' }),

  // terminals
  terminals: (id: string) => request<TerminalInfo[]>(`${p(id)}/terminals`),
  createTerminal: (id: string, body: CreateTerminalRequest) =>
    request<TerminalInfo>(`${p(id)}/terminals`, { method: 'POST', body }),
  deleteTerminal: (id: string, termId: string) =>
    request<Ok>(`${p(id)}/terminals/${encodeURIComponent(termId)}`, { method: 'DELETE' }),

  // files
  listDir: (id: string, path: string) => request<FsEntry[]>(`${p(id)}/fs`, { query: { path } }),
  readFile: (id: string, path: string) => request<FsReadResult>(`${p(id)}/fs/file`, { query: { path } }),
  writeFile: (id: string, path: string, content: string) =>
    request<Ok>(`${p(id)}/fs/file`, { method: 'PUT', body: { path, content } }),
  mkdir: (id: string, path: string) => request<Ok>(`${p(id)}/fs/mkdir`, { method: 'POST', body: { path } }),
  rename: (id: string, from: string, to: string) =>
    request<Ok>(`${p(id)}/fs/rename`, { method: 'POST', body: { from, to } }),
  deletePath: (id: string, path: string) => request<Ok>(`${p(id)}/fs`, { method: 'DELETE', query: { path } }),

  ports: (id: string) => request<ListeningPort[]>(`${p(id)}/ports`),

  // providers
  providers: () => request<Provider[]>('/providers'),
  createProvider: (body: ProviderInput) => request<Provider>('/providers', { method: 'POST', body }),
  updateProvider: (id: string, body: Partial<ProviderInput>) =>
    request<Provider>(`/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteProvider: (id: string) => request<Ok>(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  chatgptDeviceStart: () => request<ChatGptDeviceStart>('/providers/chatgpt/device/start', { method: 'POST' }),
  chatgptDevicePoll: (handle: string) => request<ChatGptDevicePoll>('/providers/chatgpt/device/poll', { method: 'POST', body: { handle } }),

  // agent profiles
  profiles: () => request<AgentProfile[]>('/agent-profiles'),
  createProfile: (body: AgentProfileInput) => request<AgentProfile>('/agent-profiles', { method: 'POST', body }),
  updateProfile: (id: string, body: Partial<AgentProfileInput>) =>
    request<AgentProfile>(`/agent-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteProfile: (id: string) => request<Ok>(`/agent-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
