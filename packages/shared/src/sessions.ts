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
}

export interface PromptRequest { text: string; images?: ImageInput[] }
export interface ApprovalResponse { requestId: string; optionId: string }
