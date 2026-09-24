import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentSession,
  ApprovalPolicy,
  CreateSessionRequest,
  ImageInput,
  PromptRequest,
  QuestionResponse,
  ServerEvent,
  SessionEventRecord,
} from '@vibe/shared';
import { request } from '@/lib/api';
import { useAgents } from '@/lib/queries';
import { controlSocket } from '@/lib/ws';

type Ok = { ok: true };
const s = (sid: string) => `/sessions/${encodeURIComponent(sid)}`;

export const chatApi = {
  sessions: (projectId: string) => request<AgentSession[]>(`/projects/${encodeURIComponent(projectId)}/sessions`),
  createSession: (projectId: string, body: CreateSessionRequest) =>
    request<AgentSession>(`/projects/${encodeURIComponent(projectId)}/sessions`, { method: 'POST', body }),
  session: (sid: string) => request<AgentSession>(s(sid)),
  rename: (sid: string, title: string) => request<AgentSession>(s(sid), { method: 'PATCH', body: { title } }),
  remove: (sid: string) => request<Ok>(s(sid), { method: 'DELETE' }),
  events: (sid: string, since?: number) =>
    request<SessionEventRecord[]>(`${s(sid)}/events`, { query: { since: since !== undefined && since >= 0 ? since : undefined } }),
  prompt: (sid: string, body: PromptRequest) => request<Ok>(`${s(sid)}/prompt`, { method: 'POST', body }),
  cancel: (sid: string) => request<Ok>(`${s(sid)}/cancel`, { method: 'POST' }),
  approval: (sid: string, requestId: string, optionId: string) =>
    request<Ok>(`${s(sid)}/approval`, { method: 'POST', body: { requestId, optionId } }),
  answer: (sid: string, body: QuestionResponse) => request<Ok>(`${s(sid)}/answer`, { method: 'POST', body }),
  mode: (sid: string, mode: string) => request<Ok>(`${s(sid)}/mode`, { method: 'POST', body: { mode } }),
  approvalPolicy: (sid: string, policy: ApprovalPolicy) =>
    request<AgentSession>(`${s(sid)}/approval-policy`, { method: 'POST', body: { policy } }),
  model: (sid: string, model: string) => request<Ok>(`${s(sid)}/model`, { method: 'POST', body: { model } }),
  stop: (sid: string) => request<Ok>(`${s(sid)}/stop`, { method: 'POST' }),
  resume: (sid: string) => request<Ok>(`${s(sid)}/resume`, { method: 'POST' }),
};

export const chatKeys = {
  sessions: (projectId: string) => ['sessions', projectId] as const,
  session: (sid: string) => ['session', sid] as const,
};

/** Session list of a project, kept live via `session.updated` / `session.deleted` on `project:<id>`. */
export function useSessions(projectId: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: chatKeys.sessions(projectId),
    queryFn: () => chatApi.sessions(projectId),
    enabled: !!projectId,
  });

  React.useEffect(() => {
    const offEv = controlSocket.onEvent((ev: ServerEvent) => {
      if (ev.type === 'session.updated' && ev.projectId === projectId) {
        upsertSession(qc, ev.session);
      } else if (ev.type === 'session.deleted' && ev.projectId === projectId) {
        qc.setQueryData<AgentSession[]>(chatKeys.sessions(projectId), (old) => old?.filter((x) => x.id !== ev.sessionId));
      }
    });
    const offState = controlSocket.onState((connected) => {
      if (connected) void qc.invalidateQueries({ queryKey: chatKeys.sessions(projectId) });
    });
    return () => {
      offEv();
      offState();
    };
  }, [projectId, qc]);

  return query;
}

export function upsertSession(qc: ReturnType<typeof useQueryClient>, session: AgentSession) {
  qc.setQueryData<AgentSession[]>(chatKeys.sessions(session.projectId), (old) => {
    if (!old) return [session];
    const i = old.findIndex((x) => x.id === session.id);
    const next = i < 0 ? [session, ...old] : old.slice();
    if (i >= 0) next[i] = session;
    // same order as the server: most recent activity first
    return next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  });
  qc.setQueryData(chatKeys.session(session.id), session);
}

/** Session record, from the project list cache when possible. */
export function useSession(projectId: string, sid: string | undefined) {
  const list = useSessions(projectId);
  const fromList = sid ? list.data?.find((x) => x.id === sid) : undefined;
  const single = useQuery({
    queryKey: chatKeys.session(sid ?? ''),
    queryFn: () => chatApi.session(sid!),
    enabled: !!sid && !fromList && list.isSuccess,
  });
  return {
    session: fromList ?? (single.data?.projectId === projectId ? single.data : undefined),
    /** The session does not exist (anymore). */
    missing: !!sid && !fromList && (single.isError || (single.isSuccess && single.data.projectId !== projectId)),
  };
}

/** Agents with a structured (chat) interface. */
export function useChatAgents() {
  const agents = useAgents();
  const data = React.useMemo(() => (agents.data ?? []).filter((a) => !!a.structured), [agents.data]);
  return { ...agents, data };
}

export function useCreateSession(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSessionRequest) => chatApi.createSession(projectId, body),
    onSuccess: (session) => upsertSession(qc, session),
    // errors are rendered inline by the caller (claude_subscription_chat needs special UI)
    onError: () => {},
  });
}

export function useSessionActions(sid: string) {
  return React.useMemo(
    () => ({
      prompt: (text: string, images?: ImageInput[]) => chatApi.prompt(sid, { text, images: images?.length ? images : undefined }),
      cancel: () => chatApi.cancel(sid),
      approval: (requestId: string, optionId: string) => chatApi.approval(sid, requestId, optionId),
      answer: (body: QuestionResponse) => chatApi.answer(sid, body),
      mode: (mode: string) => chatApi.mode(sid, mode),
      approvalPolicy: (policy: ApprovalPolicy) => chatApi.approvalPolicy(sid, policy),
      model: (model: string) => chatApi.model(sid, model),
      stop: () => chatApi.stop(sid),
      resume: () => chatApi.resume(sid),
    }),
    [sid],
  );
}
