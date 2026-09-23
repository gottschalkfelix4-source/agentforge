// Normalized agent event model (Phase 2). Shaped after the Agent Client Protocol (ACP);
// native adapters (Codex app-server) map onto the same events.

export type SessionStatus = 'starting' | 'idle' | 'running' | 'awaiting_approval' | 'error' | 'stopped';

/** `agent`: a sub-agent (Claude Code Task/Agent tool, Codex spawned agent); its own steps carry `parentId`. */
export type ToolKind = 'exec' | 'edit' | 'read' | 'search' | 'fetch' | 'mcp' | 'think' | 'agent' | 'other';
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface FileDiff {
  /** Path relative to the session cwd (or absolute inside the container). */
  path: string;
  oldText: string | null;
  newText: string | null;
  /** Optional unified diff, when the agent provides one instead of full texts. */
  unified?: string;
}

export interface ApprovalOption {
  id: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** One field of an agent question (ACP form elicitation, e.g. Claude Code's AskUserQuestion). */
export interface QuestionField {
  key: string;
  kind: 'single' | 'multi' | 'text' | 'boolean' | 'number';
  title?: string;
  description?: string;
  options?: { value: string; label: string; description?: string; preview?: string }[];
  /** Free-text field that complements the choice field with this key ("Eigene Antwort"). */
  customFor?: string;
  required?: boolean;
}

export type QuestionAnswers = Record<string, string | string[] | boolean | number>;

export interface PlanEntry {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ImageInput {
  mime: string;
  /** base64 without data: prefix */
  data: string;
}

export type AgentEvent =
  /** Echo of a user prompt, so the transcript is complete from events alone. */
  | { type: 'user.message'; id: string; text: string; images?: ImageInput[] }
  /** `parentId`: the message belongs to the sub-agent run by that tool (not the main answer). */
  | { type: 'message.delta'; id: string; role: 'assistant' | 'thought'; text: string; parentId?: string }
  | {
      type: 'message.done';
      id: string;
      role: 'assistant' | 'thought';
      text: string;
      /** Time from the first streamed chunk to completion (e.g. "Nachgedacht für 12 s"). */
      durationMs?: number;
      parentId?: string;
    }
  /** `parentId`: tool call made by the sub-agent that the tool `parentId` runs. */
  | { type: 'tool.start'; id: string; kind: ToolKind; title: string; input?: unknown; locations?: string[]; parentId?: string }
  | {
      type: 'tool.update';
      id: string;
      status?: ToolStatus;
      title?: string;
      /** Appended output (e.g. command stdout chunk). */
      output?: string;
      diffs?: FileDiff[];
      locations?: string[];
    }
  | { type: 'tool.done'; id: string; status: 'completed' | 'failed'; output?: string; diffs?: FileDiff[] }
  | {
      type: 'approval.request';
      id: string;
      toolId?: string;
      kind: 'exec' | 'edit' | 'other';
      title: string;
      detail?: string;
      diffs?: FileDiff[];
      options: ApprovalOption[];
    }
  | { type: 'approval.resolved'; id: string; optionId: string }
  /** The agent asks the user something (answer via agent.answer). */
  | { type: 'question.request'; id: string; toolId?: string; message: string; fields: QuestionField[] }
  | { type: 'question.resolved'; id: string; action: 'accept' | 'decline' | 'cancel'; answers?: QuestionAnswers }
  | { type: 'plan'; entries: PlanEntry[] }
  /** System notice from the agent runtime (warnings, fallbacks) — not part of the agent's answer. */
  | { type: 'notice'; severity: 'info' | 'warning' | 'error'; title: string; description?: string }
  | { type: 'diff.turn'; files: FileDiff[] }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; contextPercent?: number }
  | { type: 'status'; status: SessionStatus; message?: string }
  | { type: 'turn.start' }
  | { type: 'turn.done'; stopReason: string }
  | { type: 'error'; message: string }
  | {
      type: 'session.info';
      externalId: string;
      models?: { id: string; name: string }[];
      currentModel?: string | null;
      modes?: { id: string; name: string; description?: string }[];
      currentMode?: string | null;
      commands?: { name: string; description?: string }[];
    };

export interface SessionEventRecord {
  seq: number;
  ts: string;
  event: AgentEvent;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
