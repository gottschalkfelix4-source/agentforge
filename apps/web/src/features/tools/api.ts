import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentToolStatus, ProviderKind, ProviderTestResult, TerminalInfo } from '@vibe/shared';
import { request } from '@/lib/api';

export const toolsKeys = {
  latest: ['tools', 'latest'] as const,
  project: (projectId: string) => ['tools', 'project', projectId] as const,
  chatSettings: ['settings', 'chat'] as const,
};

const p = (id: string) => `/projects/${encodeURIComponent(id)}`;

export interface ChatSettings {
  allowClaudeSubscriptionChat: boolean;
}

export const toolsApi = {
  latest: () => request<AgentToolStatus[]>('/tools/latest'),
  projectTools: (projectId: string) => request<AgentToolStatus[]>(`${p(projectId)}/tools`),
  install: (projectId: string, agentId: string, size?: { cols: number; rows: number }) =>
    request<TerminalInfo>(`${p(projectId)}/tools/install`, { method: 'POST', body: { agentId, ...size } }),
  chatSettings: () => request<ChatSettings>('/settings/chat'),
  setChatSettings: (body: ChatSettings) => request<ChatSettings>('/settings/chat', { method: 'PUT', body }),
  /** Test an unsaved provider configuration. */
  testProvider: (body: { kind: ProviderKind; baseUrl?: string | null; apiKey?: string }) =>
    request<ProviderTestResult>('/providers/test', { method: 'POST', body }),
  /** Test a saved provider; optional overrides use the stored key with changed kind/URL. */
  testSavedProvider: (id: string, body: { kind?: ProviderKind; baseUrl?: string | null; apiKey?: string } = {}) =>
    request<ProviderTestResult>(`/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body }),
};

export const useLatestTools = () => useQuery({ queryKey: toolsKeys.latest, queryFn: toolsApi.latest, staleTime: 10 * 60_000 });

export const useProjectTools = (projectId: string | null) =>
  useQuery({
    queryKey: toolsKeys.project(projectId ?? ''),
    queryFn: () => toolsApi.projectTools(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: false,
  });

export const useChatSettings = () => useQuery({ queryKey: toolsKeys.chatSettings, queryFn: toolsApi.chatSettings });

export function useSetChatSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: toolsApi.setChatSettings,
    onSuccess: (data) => qc.setQueryData(toolsKeys.chatSettings, data),
  });
}
