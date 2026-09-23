import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ProjectWithWorkspace, WorkspaceAction } from '@vibe/shared';
import { api, ApiRequestError } from './api';
import { errorMessage } from './utils';

export const qk = {
  me: ['me'] as const,
  system: ['system'] as const,
  agents: ['agents'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  terminals: (id: string) => ['terminals', id] as const,
  fsRoot: (id: string) => ['fs', id] as const,
  fs: (id: string, path: string) => ['fs', id, path] as const,
  file: (id: string, path: string) => ['file', id, path] as const,
  ports: (id: string) => ['ports', id] as const,
  providers: ['providers'] as const,
  profiles: ['profiles'] as const,
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => {
          if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: {
        onError: (err) => toast.error(errorMessage(err)),
      },
    },
  });
}

// ---- queries ---------------------------------------------------------------

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 60_000 });
export const useSystem = () => useQuery({ queryKey: qk.system, queryFn: api.system });
export const useAgents = () => useQuery({ queryKey: qk.agents, queryFn: api.agents, staleTime: 5 * 60_000 });
export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: api.projects });
export const useProject = (id: string) =>
  useQuery({ queryKey: qk.project(id), queryFn: () => api.project(id), enabled: !!id });
export const useTerminals = (id: string, enabled = true) =>
  useQuery({ queryKey: qk.terminals(id), queryFn: () => api.terminals(id), enabled: !!id && enabled });
export const useDir = (id: string, path: string, enabled = true) =>
  useQuery({ queryKey: qk.fs(id, path), queryFn: () => api.listDir(id, path), enabled: !!id && enabled });
export const usePorts = (id: string, enabled = true) =>
  useQuery({ queryKey: qk.ports(id), queryFn: () => api.ports(id), enabled: !!id && enabled });
export const useProviders = () => useQuery({ queryKey: qk.providers, queryFn: api.providers });
export const useProfiles = () => useQuery({ queryKey: qk.profiles, queryFn: api.profiles });

// ---- mutations ---------------------------------------------------------------

export function useWorkspaceAction(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: WorkspaceAction) => api.workspaceAction(projectId, action),
    onSuccess: (ws) => {
      const patch = (p: ProjectWithWorkspace): ProjectWithWorkspace => (p.id === projectId ? { ...p, workspace: ws } : p);
      qc.setQueryData<ProjectWithWorkspace>(qk.project(projectId), (old) => (old ? patch(old) : old));
      qc.setQueryData<ProjectWithWorkspace[]>(qk.projects, (old) => old?.map(patch));
      void qc.invalidateQueries({ queryKey: qk.projects });
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    },
  });
}
