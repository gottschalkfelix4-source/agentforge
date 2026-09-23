// Structured agent sessions (Phase 2) — browser/app-server view.
import type { ImageInput, SessionStatus } from './agent-events.js';

export type StructuredTransport = 'acp' | 'codex_app_server';

export interface AgentSession {
  id: string;
  projectId: string;
  agentId: string;
  profileId: string | null;
  transport: StructuredTransport;
  title: string;
  status: SessionStatus;
  statusMessage: string | null;
  /** Session/thread id inside the agent (for resume). */
  externalId: string | null;
  /** cwd relative to /workspace ("." or a worktree path). */
  cwd: string;
  taskRunId: string | null;
  currentModel: string | null;
  currentMode: string | null;
  /**
   * Models of the provider behind the session's profile (API key / own endpoint / Ollama).
   * null = no provider profile; the agent's own model list (session.info) applies.
   */
  providerModels: string[] | null;
  /** Model selected from `providerModels`. */
  providerModel: string | null;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionRequest {
  agentId: string;
  profileId?: string | null;
  title?: string;
  cwd?: string;
  /** Sent as the first prompt once the session is ready. */
  initialPrompt?: string;
  /** Provider model for sessions with a provider profile (defaults to the profile / provider default). */
  model?: string | null;
}

export interface PromptRequest { text: string; images?: ImageInput[] }
export interface ApprovalResponse { requestId: string; optionId: string }
export interface QuestionResponse {
  requestId: string;
  action: 'accept' | 'decline' | 'cancel';
  answers?: import('./agent-events.js').QuestionAnswers;
}
