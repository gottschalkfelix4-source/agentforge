import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePullRequest,
  GhCheck,
  GhIssue,
  GhPull,
  GhRepo,
  GitHubDevicePoll,
  GitHubDeviceStart,
  GitHubStatus,
} from '@vibe/shared';
import { request } from '@/lib/api';
import { controlSocket } from '@/lib/ws';

const p = (id: string) => `/projects/${encodeURIComponent(id)}`;

export const ghKeys = {
  status: ['github', 'status'] as const,
  client: ['github', 'client'] as const,
  repos: (q: string) => ['github', 'repos', q] as const,
  project: (projectId: string) => ['gh', projectId] as const,
  pulls: (projectId: string, state: string) => ['gh', projectId, 'pulls', state] as const,
  pull: (projectId: string, n: number) => ['gh', projectId, 'pull', n] as const,
};

export const githubApi = {
  status: () => request<GitHubStatus>('/github/status'),
  client: () => request<{ clientId: string | null; fromEnv: boolean }>('/github/client'),
  setClient: (clientId: string | null) =>
    request<{ clientId: string | null; fromEnv: boolean }>('/github/client', { method: 'PUT', body: { clientId } }),
  deviceStart: () => request<GitHubDeviceStart>('/github/device/start', { method: 'POST' }),
  devicePoll: (handle: string) => request<GitHubDevicePoll>('/github/device/poll', { method: 'POST', body: { handle } }),
  setToken: (token: string) => request<GitHubStatus>('/github/token', { method: 'POST', body: { token } }),
  disconnect: () => request<{ ok: true }>('/github', { method: 'DELETE' }),
  repos: (q: string, page = 1) => request<GhRepo[]>('/github/repos', { query: { q: q || undefined, page } }),
  orgs: () => request<{ login: string; avatarUrl: string | null }[]>('/github/orgs'),
  createRepo: (body: { name: string; private: boolean; description?: string | null; org?: string | null; autoInit?: boolean }) =>
    request<GhRepo>('/github/repos', { method: 'POST', body }),
  link: (projectId: string, owner: string, name: string) =>
    request<{ repo: GhRepo; remoteSet: boolean }>(`${p(projectId)}/github/link`, { method: 'POST', body: { owner, name } }),
  pulls: (projectId: string, state: 'open' | 'closed' | 'all') =>
    request<GhPull[]>(`${p(projectId)}/github/pulls`, { query: { state } }),
  pull: (projectId: string, n: number) => request<GhPull & { checks: GhCheck[] }>(`${p(projectId)}/github/pulls/${n}`),
  createPull: (projectId: string, body: CreatePullRequest) =>
    request<GhPull>(`${p(projectId)}/github/pulls`, { method: 'POST', body }),
  mergePull: (projectId: string, n: number, method: 'merge' | 'squash' | 'rebase') =>
    request<{ merged: boolean; message: string }>(`${p(projectId)}/github/pulls/${n}/merge`, { method: 'POST', body: { method } }),
  issues: (projectId: string, state: 'open' | 'closed' | 'all') =>
    request<GhIssue[]>(`${p(projectId)}/github/issues`, { query: { state } }),
};

export const useGitHubStatus = () => useQuery({ queryKey: ghKeys.status, queryFn: githubApi.status, staleTime: 60_000 });

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const useGitHubRepos = (q: string, enabled = true) =>
  useQuery({ queryKey: ghKeys.repos(q), queryFn: () => githubApi.repos(q), enabled, staleTime: 60_000 });

export const usePulls = (projectId: string, enabled: boolean, state: 'open' | 'closed' | 'all' = 'open') =>
  useQuery({
    queryKey: ghKeys.pulls(projectId, state),
    queryFn: () => githubApi.pulls(projectId, state),
    enabled,
    staleTime: 30_000,
  });

export function useCreatePull(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePullRequest) => githubApi.createPull(projectId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ghKeys.project(projectId) }),
  });
}

export function useMergePull(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ n, method }: { n: number; method: 'merge' | 'squash' | 'rebase' }) => githubApi.mergePull(projectId, n, method),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ghKeys.project(projectId) });
      void qc.invalidateQueries({ queryKey: ['git', projectId] });
    },
  });
}

/** Refetch GitHub data of a project on `github.changed`. */
export function useGitHubLive(projectId: string) {
  const qc = useQueryClient();
  React.useEffect(
    () =>
      controlSocket.onEvent((ev) => {
        if (ev.type === 'github.changed' && ev.projectId === projectId) {
          void qc.invalidateQueries({ queryKey: ghKeys.project(projectId) });
        }
      }),
    [projectId, qc],
  );
}

export const useGitHubOrgs = (enabled = true) =>
  useQuery({ queryKey: ['github', 'orgs'] as const, queryFn: githubApi.orgs, enabled, staleTime: 5 * 60_000 });
