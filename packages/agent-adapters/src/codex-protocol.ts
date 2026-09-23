// Subset of the Codex app-server protocol (v2), vendored from
// `codex app-server generate-ts` (codex-cli 0.156.1). Only what the adapter uses.

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean; optOutNotificationMethods?: string[] | null } | null;
}
export interface InitializeResponse { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
}
export interface ThreadResumeParams extends ThreadStartParams { threadId: string; excludeTurns?: boolean }
export interface Thread { id: string; model: string | null; cwd: string; name: string | null }
export interface ThreadStartResponse { thread: Thread; model: string; approvalPolicy: unknown; sandbox: SandboxPolicy }

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  /** Reasoning summary verbosity ("auto" | "concise" | "detailed" | "none"). */
  summary?: 'auto' | 'concise' | 'detailed' | 'none' | null;
}
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export interface TurnError { message: string; additionalDetails: string | null }
export interface Turn { id: string; status: TurnStatus; error: TurnError | null }
export interface TurnStartResponse { turn: Turn }

export interface FileUpdateChange { path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }; diff: string }
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export type ThreadItem =
  | { type: 'userMessage'; id: string }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; status: ItemStatus; aggregatedOutput: string | null; exitCode: number | null }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: ItemStatus }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: 'inProgress' | 'completed' | 'failed'; arguments: unknown; result: { content?: unknown[] } | null; error: { message: string } | null }
  | { type: 'dynamicToolCall'; id: string; tool: string; arguments: unknown; status: string; success: boolean | null }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'imageView'; id: string; path: string }
  | CollabAgentToolCallItem
  | { type: string; id: string };

export type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | 'sendMessage' | 'followupTask' | 'interruptAgent' | 'listAgents';
export type CollabAgentStatus = 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound';
/** Multi-agent ("collab") tool call: spawning / messaging / waiting for sub-agents, which run in their own threads. */
export interface CollabAgentToolCallItem {
  type: 'collabAgentToolCall';
  id: string;
  tool: CollabAgentTool;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  senderThreadId: string;
  /** For spawnAgent: the new sub-agent's thread. */
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  agentsStates: Record<string, { status: CollabAgentStatus; message: string | null } | undefined>;
}

export interface ItemNotification { item: ThreadItem; threadId: string; turnId: string }
export interface DeltaNotification { threadId: string; turnId: string; itemId: string; delta: string }
export interface TurnNotification { threadId: string; turn: Turn }
export interface TurnDiffUpdatedNotification { threadId: string; turnId: string; diff: string }
export interface TurnPlanUpdatedNotification { threadId: string; turnId: string; explanation: string | null; plan: { step: string; status: 'pending' | 'inProgress' | 'completed' }[] }
export interface TokenUsageBreakdown { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }
export interface ThreadTokenUsageUpdatedNotification { threadId: string; turnId: string; tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null } }
export interface ErrorNotification { error: TurnError; willRetry: boolean; threadId: string; turnId: string }

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
}
export interface FileChangeRequestApprovalParams { threadId: string; turnId: string; itemId: string; reason?: string | null; grantRoot?: string | null }
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ModelListResponse { data: { id: string; model: string; displayName: string; hidden: boolean; isDefault: boolean }[]; nextCursor: string | null }
