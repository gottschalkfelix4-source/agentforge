// Structured agent sessions (Phase 2) — browser/app-server view.
import type { ImageInput, SessionStatus } from './agent-events.js';

export type StructuredTransport = 'acp' | 'codex_app_server';

/**
 * How Agentforge answers the agent's permission requests: `ask` = the user decides, `edits` = file changes
 * are allowed automatically, `all` = everything is allowed (like Claude Code's "bypass permissions").
 */
export type ApprovalPolicy = 'ask' | 'edits' | 'all';
export const APPROVAL_POLICIES: ApprovalPolicy[] = ['ask', 'edits', 'all'];

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
  /** How permission requests of the agent are answered. */
  approvalPolicy: ApprovalPolicy;
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
  /** Default `ask`. */
  approvalPolicy?: ApprovalPolicy;
}

export interface PromptRequest { text: string; images?: ImageInput[] }
export interface ApprovalResponse { requestId: string; optionId: string }
export interface QuestionResponse {
  requestId: string;
  action: 'accept' | 'decline' | 'cancel';
  answers?: import('./agent-events.js').QuestionAnswers;
}
