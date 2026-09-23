import type { AgentEvent, ImageInput, McpServerSpec } from '@vibe/shared';

export interface AgentStartOptions {
  command: string;
  args: string[];
  /** Absolute working directory of the agent session. */
  cwd: string;
  /** Complete environment of the agent process. */
  env: Record<string, string>;
  model?: string | null;
  mode?: string | null;
  mcpServers?: McpServerSpec[];
  /** Resume this agent-side session/thread instead of creating a new one. */
  resumeExternalId?: string | null;
  /** Run the process as this uid/gid (when the host process is root). */
  uid?: number;
  gid?: number;
  /** Client name/version reported to the agent. */
  clientName?: string;
  clientVersion?: string;
  /** Timeout for the handshake (initialize + session creation). */
  startTimeoutMs?: number;
  /** Debug hook for the agent's stderr. */
  onStderr?: (line: string) => void;
}

export type AgentEventListener = (e: AgentEvent) => void;
export type AgentExitListener = (code: number | null, message?: string) => void;

export interface AgentSessionHandle {
  /**
   * Resolves once the handshake (initialize + new/loaded session) is done; rejects if
   * the agent failed to start. Prompts must wait for it.
   */
  readonly ready: Promise<void>;
  /** Agent-side session/thread id (known once `ready` resolved). */
  readonly externalId: string | null;
  /**
   * Starts a turn. Resolves as soon as the agent accepted the prompt; the end of the
   * turn is signalled by a `turn.done` event. Never call while a turn is running.
   */
  prompt(text: string, images?: ImageInput[]): Promise<void>;
  /** Cancels the running turn (pending approvals are resolved as cancelled). */
  cancel(): Promise<void>;
  /** Answers an `approval.request` event. */
  respondApproval(requestId: string, optionId: string): void;
  /** Answers an agent question (ACP form elicitation). Only adapters that ask questions implement it. */
  respondQuestion?(requestId: string, action: 'accept' | 'decline' | 'cancel', answers?: import('@vibe/shared').QuestionAnswers): void;
  setMode?(mode: string): Promise<void>;
  setModel?(model: string): Promise<void>;
  /** Kills the process. */
  dispose(): Promise<void>;
  onEvent(cb: AgentEventListener): () => void;
  onExit(cb: AgentExitListener): () => void;
}

export interface AgentAdapter {
  /** Spawns the agent process and begins the handshake (see `ready`). */
  start(opts: AgentStartOptions): AgentSessionHandle;
}
