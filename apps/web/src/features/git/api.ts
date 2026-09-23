import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GitBranches, GitCommit, GitStatus } from '@vibe/shared';
import { request } from '@/lib/api';
import { controlSocket } from '@/lib/ws';

const p = (id: string) => `/projects/${encodeURIComponent(id)}/git`;
type Ok = { ok: true };

export const gitKeys = {
  all: (projectId: string) => ['git', projectId] as const,
  status: (projectId: string) => ['git', projectId, 'status'] as const,
  branches: (projectId: string) => ['git', projectId, 'branches'] as const,
  log: (projectId: string) => ['git', projectId, 'log'] as const,
  diff: (projectId: string, path: string, staged: boolean) => ['git', projectId, 'diff', path, staged] as const,
  remote: (projectId: string) => ['git', projectId, 'remote'] as const,
};

export const gitApi = {
  status: (id: string) => request<GitStatus>(`${p(id)}/status`),
  diff: (id: string, path: string, staged: boolean) =>
    request<{ diff: string }>(`${p(id)}/diff`, { query: { path, staged: staged ? 1 : 0 } }),
  stage: (id: string, paths: string[]) => request<Ok>(`${p(id)}/stage`, { method: 'POST', body: { paths } }),
  unstage: (id: string, paths: string[]) => request<Ok>(`${p(id)}/unstage`, { method: 'POST', body: { paths } }),
  discard: (id: string, paths: string[]) => request<Ok>(`${p(id)}/discard`, { method: 'POST', body: { paths } }),
  commit: (id: string, message: string, all: boolean) =>
    request<{ sha: string }>(`${p(id)}/commit`, { method: 'POST', body: { message, all } }),
  push: (id: string) => request<{ output: string }>(`${p(id)}/push`, { method: 'POST', body: {} }),
  pull: (id: string) => request<{ output: string }>(`${p(id)}/pull`, { method: 'POST', body: {} }),
  fetch: (id: string) => request<{ output: string }>(`${p(id)}/fetch`, { method: 'POST', body: {} }),
  branches: (id: string) => request<GitBranches>(`${p(id)}/branches`),
  checkout: (id: string, branch: string, create = false) =>
    request<Ok>(`${p(id)}/checkout`, { method: 'POST', body: { branch, create } }),
  log: (id: string, limit = 30) => request<GitCommit[]>(`${p(id)}/log`, { query: { limit } }),
  init: (id: string) => request<Ok>(`${p(id)}/init`, { method: 'POST', body: {} }),
  remote: (id: string) => request<{ url: string | null }>(`${p(id)}/remote`),
  setRemote: (id: string, url: string) => request<Ok>(`${p(id)}/remote`, { method: 'PUT', body: { name: 'origin', url } }),
};

export const useGitStatus = (projectId: string, enabled = true) =>
  useQuery({ queryKey: gitKeys.status(projectId), queryFn: () => gitApi.status(projectId), enabled, staleTime: 5_000 });

export const useGitBranches = (projectId: string, enabled = true) =>
  useQuery({ queryKey: gitKeys.branches(projectId), queryFn: () => gitApi.branches(projectId), enabled });

export const useGitLog = (projectId: string, enabled = true) =>
  useQuery({ queryKey: gitKeys.log(projectId), queryFn: () => gitApi.log(projectId, 30), enabled });

export const useGitRemote = (projectId: string, enabled = true) =>
  useQuery({ queryKey: gitKeys.remote(projectId), queryFn: () => gitApi.remote(projectId), enabled });

export const useGitDiff = (projectId: string, path: string | null, staged: boolean) =>
  useQuery({
    queryKey: gitKeys.diff(projectId, path ?? '', staged),
    queryFn: () => gitApi.diff(projectId, path!, staged),
    enabled: !!path,
  });

/** Wraps a git mutation and refreshes all git queries of the project afterwards. */
export function useGitMutation<V, R>(projectId: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: gitKeys.all(projectId) }),
  });
}

/** Refresh on `git.changed` (debounced a little, events can burst). */
export function useGitLive(projectId: string) {
  const qc = useQueryClient();
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = controlSocket.onEvent((ev) => {
      if (ev.type !== 'git.changed' || ev.projectId !== projectId) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void qc.invalidateQueries({ queryKey: gitKeys.all(projectId) });
      }, 250);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, qc]);
}
