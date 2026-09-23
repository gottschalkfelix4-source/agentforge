// Protocol between the app server and the workspace daemon (wsd) that runs
// inside every workspace container.
//
// Control channel: WebSocket `ws://<container>:7777/rpc` (header `Authorization: Bearer <token>`)
//   carrying JSON-RPC 2.0 requests/responses and notifications.
// Preview tunnel: HTTP + WebSocket `/proxy/<port>/<path>` (same auth) → 127.0.0.1:<port>/<path>.
// Terminal channel: WebSocket `ws://<container>:7777/term/<id>` (same auth)
//   binary frames = raw PTY bytes (both directions); text frames = TermControl JSON.

import type { AgentEvent, ImageInput, McpServerSpec, QuestionAnswers, SessionEventRecord } from './agent-events.js';
import type { GitBranches, GitCommit, GitCwd, GitStatus, GitWorktree } from './git.js';
import type { FsEntry, TerminalInfo } from './models.js';
import type { StructuredTransport } from './sessions.js';

export const WSD_PORT = 7777;

export interface RpcRequest<M extends string = string, P = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params: P;
}

export interface RpcResponse<R = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification<M extends string = string, P = unknown> {
  jsonrpc: '2.0';
  method: M;
  params: P;
}

export interface TermCreateParams {
  /** Executable; defaults to the user's login shell. */
  command?: string;
  args?: string[];
  cwd?: string;
  /** Extra env for this process only (secrets are passed here, never as container env). */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface FsListParams { path: string }
export interface FsReadParams { path: string }
export interface FsReadResult { path: string; content: string; encoding: 'utf8' | 'base64'; size: number }
export interface FsWriteParams { path: string; content: string; encoding?: 'utf8' | 'base64' }
export interface FsPathParams { path: string }
export interface FsRenameParams { from: string; to: string }

export interface ListeningPort { port: number; address: string }

// ---- agents (Phase 2) -------------------------------------------------------

export interface AgentStartParams {
  /** App-side session id; all events are keyed by it. */
  sessionId: string;
  agentId: string;
  transport: StructuredTransport;
  command: string;
  args: string[];
  /** Relative to /workspace. */
  cwd: string;
  env: Record<string, string>;
  model?: string | null;
  mode?: string | null;
  mcpServers: McpServerSpec[];
  /** Resume an existing agent-side session/thread. */
  resumeExternalId?: string | null;
  /** Last event seq already persisted by the app; wsd continues numbering after it (additive, Phase 2). */
  startSeq?: number | null;
}

export interface AgentSessionState {
  sessionId: string;
  running: boolean;
  lastSeq: number;
  externalId: string | null;
}

// ---- tools (Phase 6) ----------------------------------------------------------

export interface ToolVersion { agentId: string; bin: string; version: string | null }

/** Method name → [params, result] */
export interface WsdMethods {
  'ping': [Record<string, never>, { version: string; uptime: number }];
  'term.create': [TermCreateParams, TerminalInfo];
  'term.list': [Record<string, never>, TerminalInfo[]];
  'term.kill': [{ id: string }, { ok: true }];
  'term.resize': [{ id: string; cols: number; rows: number }, { ok: true }];
  'fs.list': [FsListParams, FsEntry[]];
  'fs.read': [FsReadParams, FsReadResult];
  'fs.write': [FsWriteParams, { ok: true }];
  'fs.mkdir': [FsPathParams, { ok: true }];
  'fs.delete': [FsPathParams, { ok: true }];
  'fs.rename': [FsRenameParams, { ok: true }];
  'ports.list': [Record<string, never>, ListeningPort[]];

  // agents — wsd hosts structured agent processes so they survive app restarts
  'agent.start': [AgentStartParams, { externalId: string | null }];
  'agent.prompt': [{ sessionId: string; text: string; images?: ImageInput[] }, { ok: true }];
  'agent.cancel': [{ sessionId: string }, { ok: true }];
  'agent.respond': [{ sessionId: string; requestId: string; optionId: string }, { ok: true }];
  'agent.answer': [
    { sessionId: string; requestId: string; action: 'accept' | 'decline' | 'cancel'; answers?: QuestionAnswers },
    { ok: true },
  ];
  'agent.setMode': [{ sessionId: string; value: string }, { ok: true }];
  'agent.setModel': [{ sessionId: string; value: string }, { ok: true }];
  'agent.stop': [{ sessionId: string }, { ok: true }];
  'agent.list': [Record<string, never>, AgentSessionState[]];
  /** Buffered events with seq > since (wsd keeps the last ~5000 per session). */
  'agent.events': [{ sessionId: string; since: number }, SessionEventRecord[]];

  // git — cwd relative to /workspace
  'git.status': [GitCwd, GitStatus];
  'git.diff': [GitCwd & { path?: string; staged?: boolean }, { diff: string }];
  'git.stage': [GitCwd & { paths: string[] }, { ok: true }];
  'git.unstage': [GitCwd & { paths: string[] }, { ok: true }];
  'git.discard': [GitCwd & { paths: string[] }, { ok: true }];
  'git.commit': [GitCwd & { message: string; all?: boolean }, { sha: string }];
  'git.push': [GitCwd & { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean }, { output: string }];
  'git.pull': [GitCwd & { remote?: string; branch?: string }, { output: string }];
  'git.fetch': [GitCwd & { remote?: string }, { output: string }];
  'git.branches': [GitCwd, GitBranches];
  'git.checkout': [GitCwd & { branch: string; create?: boolean; startPoint?: string }, { ok: true }];
  'git.log': [GitCwd & { limit?: number; ref?: string }, GitCommit[]];
  'git.init': [GitCwd & { defaultBranch?: string }, { ok: true }];
  'git.clone': [{ url: string }, { ok: true }];
  'git.remote.set': [GitCwd & { name: string; url: string }, { ok: true }];
  'git.remote.get': [GitCwd & { name?: string }, { url: string | null }];
  'git.worktree.add': [{ path: string; branch: string; base?: string }, GitWorktree];
  'git.worktree.remove': [{ path: string; force?: boolean }, { ok: true }];
  'git.worktree.list': [Record<string, never>, GitWorktree[]];
  /** In-memory credentials served to git via the wsd credential helper. */
  'git.credentials.set': [{ host: string; username: string; token: string } | { host: string; clear: true }, { ok: true }];
  'git.identity.set': [{ name: string; email: string }, { ok: true }];

  // tools (Phase 6)
  'tools.versions': [Record<string, never>, ToolVersion[]];
}

export type WsdMethod = keyof WsdMethods;

/** Notifications sent by wsd on the control channel. */
export interface WsdNotifications {
  'term.exit': { id: string; exitCode: number | null };
  'term.title': { id: string; title: string };
  'fs.changed': { paths: string[] };
  'ports.changed': { ports: ListeningPort[] };
  'agent.event': { sessionId: string; seq: number; ts: string; event: AgentEvent };
  'agent.exit': { sessionId: string; code: number | null; message?: string };
}

export type TermControl =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'error'; message: string };
