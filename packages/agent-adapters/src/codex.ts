// Codex app-server adapter: `codex app-server` speaks JSON-RPC 2.0 (newline-delimited,
// without the "jsonrpc" field on its side) over stdio.
// Flow: initialize → initialized → thread/start|thread/resume → turn/start … turn/completed.

import type { AgentEvent, ApprovalOption, FileDiff, ImageInput, McpServerSpec, ToolKind } from '@vibe/shared';
import { BaseSession, newId } from './base.js';
import { RpcError, type RpcId } from './jsonrpc.js';
import type * as cx from './codex-protocol.js';
import type { AgentAdapter, AgentSessionHandle, AgentStartOptions } from './types.js';

/**
 * Approval modes offered for Codex. The Linux sandbox (bubblewrap) cannot create namespaces
 * inside an unprivileged container, so the sandbox is always "danger-full-access" (the
 * workspace container is the sandbox) and modes only differ in the approval policy.
 */
export const CODEX_MODES: { id: string; name: string; description: string; approvalPolicy: cx.AskForApproval }[] = [
  { id: 'ask', name: 'Nachfragen', description: 'Fragt vor Befehlen, die nicht als sicher bekannt sind', approvalPolicy: 'untrusted' },
  { id: 'auto', name: 'Automatisch', description: 'Codex entscheidet selbst, wann es nachfragt', approvalPolicy: 'on-request' },
  { id: 'full', name: 'Vollzugriff', description: 'Führt alles ohne Rückfrage aus', approvalPolicy: 'never' },
];
const DEFAULT_MODE = 'ask';

const CODEX_OPTIONS: ApprovalOption[] = [
  { id: 'accept', label: 'Erlauben', kind: 'allow_once' },
  { id: 'acceptForSession', label: 'Für diese Sitzung erlauben', kind: 'allow_always' },
  { id: 'decline', label: 'Ablehnen', kind: 'reject_once' },
  { id: 'cancel', label: 'Ablehnen und Turn abbrechen', kind: 'reject_always' },
];

/** TOML value for a `-c key=value` override (JSON strings/arrays are valid TOML). */
function tomlValue(v: string | string[] | Record<string, string>): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(s)).join(', ')}]`;
  return `{ ${Object.entries(v)
    .map(([k, val]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${JSON.stringify(val)}`)
    .join(', ')} }`;
}

/** `-c mcp_servers.<name>.…` overrides for the codex command line. */
export function codexMcpArgs(servers: McpServerSpec[]): string[] {
  const args: string[] = [];
  for (const s of servers) {
    const key = /^[A-Za-z0-9_-]+$/.test(s.name) ? s.name : JSON.stringify(s.name);
    args.push('-c', `mcp_servers.${key}.command=${tomlValue(s.command)}`);
    args.push('-c', `mcp_servers.${key}.args=${tomlValue(s.args)}`);
    if (Object.keys(s.env).length) args.push('-c', `mcp_servers.${key}.env=${tomlValue(s.env)}`);
  }
  return args;
}

/** Splits a multi-file unified diff (git format) into per-file entries. */
export function splitUnifiedDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(chunk)?.[1];
    const minus = /^--- (?:a\/)?(.+)$/m.exec(chunk)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    let p = plus && plus !== '/dev/null' ? plus : minus && minus !== '/dev/null' ? minus : header?.[2];
    if (!p) continue;
    p = p.trim();
    out.push({ path: p, oldText: null, newText: null, unified: chunk });
  }
  return out;
}

interface ToolState {
  kind: ToolKind;
  streamed: boolean;
  done: boolean;
  diffs?: FileDiff[];
}

interface PendingApproval {
  rpcId: RpcId;
  legacy: boolean;
  resolve: (decision: cx.ApprovalDecision) => void;
}

export class CodexSession extends BaseSession {
  private threadId: string | null = null;
  private turnId: string | null = null;
  private turnActive = false;
  private mode = DEFAULT_MODE;
  private model: string | null;
  private readonly tools = new Map<string, ToolState>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** Reasoning items that already streamed summary text (raw deltas are then ignored). */
  private readonly reasoningSummary = new Set<string>();
  private turnErrorReported = false;

  constructor(opts: AgentStartOptions) {
    super({ ...opts, args: [...opts.args, ...codexMcpArgs(opts.mcpServers ?? [])] });
    this.model = opts.model ?? null;
    if (opts.mode && CODEX_MODES.some((m) => m.id === opts.mode)) this.mode = opts.mode;
    this.rpc.onNotification = (method, params) => this.onNotification(method, params);
    this.rpc.onRequest = (method, params, id) => this.onServerRequest(method, params, id);
  }

  private get policy(): cx.AskForApproval {
    return CODEX_MODES.find((m) => m.id === this.mode)?.approvalPolicy ?? 'untrusted';
  }

  protected async handshake(): Promise<void> {
    await this.rpc.request<cx.InitializeResponse>('initialize', {
      clientInfo: { name: this.opts.clientName ?? 'agentforge', title: 'Agentforge', version: this.opts.clientVersion ?? '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    } satisfies cx.InitializeParams);
    this.rpc.notify('initialized');

    const base: cx.ThreadStartParams = {
      cwd: this.opts.cwd,
      approvalPolicy: this.policy,
      sandbox: 'danger-full-access',
      ...(this.model ? { model: this.model } : {}),
    };
    let res: cx.ThreadStartResponse | null = null;
    if (this.opts.resumeExternalId) {
      try {
        res = await this.rpc.request<cx.ThreadStartResponse>('thread/resume', {
          ...base,
          threadId: this.opts.resumeExternalId,
          excludeTurns: true,
        } satisfies cx.ThreadResumeParams);
      } catch (err) {
        this.emit({ type: 'error', message: `Fortsetzen fehlgeschlagen (${(err as Error).message}) – neuer Thread gestartet.` });
      }
    }
    if (!res) res = await this.rpc.request<cx.ThreadStartResponse>('thread/start', base);
    this.threadId = res.thread.id;
    this.externalId = res.thread.id;
    if (res.model) this.model = res.model;
    this.info = {
      ...this.info,
      modes: CODEX_MODES.map(({ id, name, description }) => ({ id, name, description })),
      currentMode: this.mode,
      currentModel: this.model,
    };
    this.updateInfo({});
    // Model list needs a login; failures are fine.
    this.rpc
      .request<cx.ModelListResponse>('model/list', {}, 15_000)
      .then((r) => {
        const models = (r?.data ?? []).filter((m) => !m.hidden).map((m) => ({ id: m.model || m.id, name: m.displayName || m.model }));
        if (models.length) this.updateInfo({ models });
      })
      .catch(() => undefined);
  }

  // ---- server → client requests ------------------------------------------------

  private onServerRequest(method: string, params: unknown, rpcId: RpcId): unknown {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = params as cx.CommandExecutionRequestApprovalParams;
        return this.approval(rpcId, false, {
          toolId: p.itemId,
          kind: 'exec',
          title: p.command ? `Befehl ausführen: ${p.command}` : 'Befehl ausführen',
          detail: [p.reason, p.cwd ? `in ${p.cwd}` : null].filter(Boolean).join('\n') || undefined,
        }).then((decision) => ({ decision }));
      }
      case 'item/fileChange/requestApproval': {
        const p = params as cx.FileChangeRequestApprovalParams;
        const diffs = this.tools.get(p.itemId)?.diffs;
        return this.approval(rpcId, false, {
          toolId: p.itemId,
          kind: 'edit',
          title: 'Dateien ändern',
          detail: p.reason ?? undefined,
          diffs,
        }).then((decision) => ({ decision }));
      }
      // Legacy (v1) approval requests.
      case 'execCommandApproval': {
        const p = params as { callId: string; command: string[]; cwd: string; reason: string | null };
        return this.approval(rpcId, true, { toolId: p.callId, kind: 'exec', title: `Befehl ausführen: ${p.command.join(' ')}`, detail: p.reason ?? undefined }).then((d) => ({
          decision: legacyDecision(d),
        }));
      }
      case 'applyPatchApproval': {
        const p = params as { callId: string; reason: string | null };
        return this.approval(rpcId, true, { toolId: p.callId, kind: 'edit', title: 'Dateien ändern', detail: p.reason ?? undefined }).then((d) => ({ decision: legacyDecision(d) }));
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new RpcError(-32601, `Agentforge unterstützt ${method} noch nicht`);
    }
  }

  private approval(
    rpcId: RpcId,
    legacy: boolean,
    req: { toolId: string; kind: 'exec' | 'edit' | 'other'; title: string; detail?: string; diffs?: FileDiff[] },
  ): Promise<cx.ApprovalDecision> {
    this.closeMessages();
    const id = newId();
    return new Promise((resolve) => {
      this.approvals.set(id, { rpcId, legacy, resolve });
      const ev: Extract<AgentEvent, { type: 'approval.request' }> = {
        type: 'approval.request',
        id,
        toolId: req.toolId,
        kind: req.kind,
        title: req.title,
        options: CODEX_OPTIONS,
      };
      if (req.detail) ev.detail = req.detail;
      if (req.diffs?.length) ev.diffs = req.diffs;
      this.emit(ev);
    });
  }

  respondApproval(requestId: string, optionId: string): void {
    const a = this.approvals.get(requestId);
    if (!a) throw new Error('Unbekannte oder bereits beantwortete Anfrage');
    const decision: cx.ApprovalDecision = CODEX_OPTIONS.some((o) => o.id === optionId) ? (optionId as cx.ApprovalDecision) : 'cancel';
    this.approvals.delete(requestId);
    a.resolve(decision);
    this.emit({ type: 'approval.resolved', id: requestId, optionId: decision });
  }

  private cancelApprovals() {
    for (const [id, a] of this.approvals) {
      a.resolve('cancel');
      this.emit({ type: 'approval.resolved', id, optionId: 'cancelled' });
    }
    this.approvals.clear();
  }

  // ---- notifications ---------------------------------------------------------------

  private onNotification(method: string, params: unknown) {
    const p = params as Record<string, unknown>;
    if (this.threadId && typeof p?.threadId === 'string' && p.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this.turnId = (params as cx.TurnNotification).turn.id;
        break;
      case 'item/started':
        this.onItemStarted((params as cx.ItemNotification).item);
        break;
      case 'item/completed':
        this.onItemCompleted((params as cx.ItemNotification).item);
        break;
      case 'item/agentMessage/delta': {
        const d = params as cx.DeltaNotification;
        this.delta('assistant', d.delta, d.itemId);
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        const d = params as cx.DeltaNotification;
        this.reasoningSummary.add(d.itemId);
        this.delta('thought', d.delta, d.itemId);
        break;
      }
      case 'item/reasoning/summaryPartAdded': {
        const d = params as { itemId: string };
        if (this.openMessageId('thought') === d.itemId) this.delta('thought', '\n\n', d.itemId);
        break;
      }
      case 'item/reasoning/textDelta': {
        const d = params as cx.DeltaNotification;
        if (!this.reasoningSummary.has(d.itemId)) this.delta('thought', d.delta, d.itemId);
        break;
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const d = params as cx.DeltaNotification;
        const t = this.tools.get(d.itemId);
        if (t) t.streamed = true;
        if (d.delta) this.emit({ type: 'tool.update', id: d.itemId, output: d.delta });
        break;
      }
      case 'turn/diff/updated':
        this.emit({ type: 'diff.turn', files: splitUnifiedDiff((params as cx.TurnDiffUpdatedNotification).diff) });
        break;
      case 'turn/plan/updated':
        this.emit({
          type: 'plan',
          entries: (params as cx.TurnPlanUpdatedNotification).plan.map((s) => ({
            text: s.step,
            status: s.status === 'inProgress' ? 'in_progress' : s.status,
          })),
        });
        break;
      case 'thread/tokenUsage/updated': {
        const u = (params as cx.ThreadTokenUsageUpdatedNotification).tokenUsage;
        const ev: Extract<AgentEvent, { type: 'usage' }> = { type: 'usage', inputTokens: u.total.inputTokens, outputTokens: u.total.outputTokens };
        if (u.modelContextWindow) ev.contextPercent = Math.round((u.last.totalTokens / u.modelContextWindow) * 1000) / 10;
        this.emit(ev);
        break;
      }
      case 'error': {
        const e = params as cx.ErrorNotification;
        if (!e.willRetry) {
          this.turnErrorReported = true;
          this.emit({ type: 'error', message: e.error.additionalDetails ? `${e.error.message}\n${e.error.additionalDetails}` : e.error.message });
        }
        break;
      }
      case 'turn/completed': {
        const t = (params as cx.TurnNotification).turn;
        // The same failure usually arrived as an `error` notification already.
        if (t.error && t.status === 'failed' && !this.turnErrorReported) this.emit({ type: 'error', message: t.error.message });
        this.finishTurn(t.status === 'completed' ? 'end_turn' : t.status === 'interrupted' ? 'cancelled' : t.status === 'failed' ? 'error' : t.status);
        break;
      }
      case 'serverRequest/resolved': {
        const rid = (params as { requestId: RpcId }).requestId;
        for (const [id, a] of this.approvals) {
          if (a.rpcId === rid) {
            this.approvals.delete(id);
            this.emit({ type: 'approval.resolved', id, optionId: 'cancelled' });
          }
        }
        break;
      }
      case 'thread/name/updated':
      case 'thread/started':
      case 'thread/status/changed':
      default:
        break;
    }
  }

  private onItemStarted(item: cx.ThreadItem) {
    switch (item.type) {
      case 'commandExecution': {
        const it = item as Extract<cx.ThreadItem, { type: 'commandExecution' }>;
        this.startTool(it.id, 'exec', it.command, { command: it.command, cwd: it.cwd });
        break;
      }
      case 'fileChange': {
        const it = item as Extract<cx.ThreadItem, { type: 'fileChange' }>;
        const diffs = this.changeDiffs(it.changes);
        this.startTool(it.id, 'edit', `Änderungen: ${diffs.map((d) => d.path).join(', ') || 'Dateien'}`, undefined, diffs.map((d) => d.path));
        const t = this.tools.get(it.id)!;
        t.diffs = diffs;
        if (diffs.length) this.emit({ type: 'tool.update', id: it.id, status: 'running', diffs });
        break;
      }
      case 'mcpToolCall': {
        const it = item as Extract<cx.ThreadItem, { type: 'mcpToolCall' }>;
        this.startTool(it.id, 'mcp', `${it.server}: ${it.tool}`, it.arguments);
        break;
      }
      case 'dynamicToolCall': {
        const it = item as Extract<cx.ThreadItem, { type: 'dynamicToolCall' }>;
        this.startTool(it.id, 'other', it.tool, it.arguments);
        break;
      }
      case 'webSearch': {
        const it = item as { id: string; query?: string };
        this.startTool(it.id, 'fetch', it.query ? `Websuche: ${it.query}` : 'Websuche');
        break;
      }
      default:
        break;
    }
  }

  private onItemCompleted(item: cx.ThreadItem) {
    switch (item.type) {
      case 'agentMessage':
        this.finishMessage('assistant', item.id, (item as { text: string }).text);
        break;
      case 'plan':
        this.finishMessage('assistant', item.id, (item as { text: string }).text);
        break;
      case 'reasoning': {
        const it = item as Extract<cx.ThreadItem, { type: 'reasoning' }>;
        const text = it.summary.length ? it.summary.join('\n\n') : it.content.join('\n');
        this.finishMessage('thought', it.id, text);
        break;
      }
      case 'commandExecution': {
        const it = item as Extract<cx.ThreadItem, { type: 'commandExecution' }>;
        const ok = it.status === 'completed' && (it.exitCode === null || it.exitCode === 0);
        this.doneTool(it.id, ok ? 'completed' : 'failed', it.aggregatedOutput ?? undefined);
        break;
      }
      case 'fileChange': {
        const it = item as Extract<cx.ThreadItem, { type: 'fileChange' }>;
        this.doneTool(it.id, it.status === 'completed' ? 'completed' : 'failed', undefined, this.changeDiffs(it.changes));
        break;
      }
      case 'mcpToolCall': {
        const it = item as Extract<cx.ThreadItem, { type: 'mcpToolCall' }>;
        const out = it.error?.message ?? mcpResultText(it.result);
        this.doneTool(it.id, it.status === 'completed' ? 'completed' : 'failed', out);
        break;
      }
      case 'dynamicToolCall': {
        const it = item as Extract<cx.ThreadItem, { type: 'dynamicToolCall' }>;
        this.doneTool(it.id, it.success === false || it.status === 'failed' ? 'failed' : 'completed');
        break;
      }
      case 'webSearch':
        this.doneTool(item.id, 'completed');
        break;
      default:
        break;
    }
  }

  private changeDiffs(changes: cx.FileUpdateChange[]): FileDiff[] {
    return changes.map((c) => ({
      path: this.rel(c.path),
      oldText: null,
      newText: null,
      unified: c.diff,
    }));
  }

  private finishMessage(role: 'assistant' | 'thought', id: string, text: string) {
    if (this.openMessageId(role) === id) this.closeMessage(role, text);
    else if (text) {
      this.closeMessages();
      this.emit({ type: 'message.done', id, role, text });
    }
  }

  private startTool(id: string, kind: ToolKind, title: string, input?: unknown, locations?: string[]) {
    this.closeMessages();
    if (this.tools.has(id)) return;
    this.tools.set(id, { kind, streamed: false, done: false });
    const ev: Extract<AgentEvent, { type: 'tool.start' }> = { type: 'tool.start', id, kind, title };
    if (input !== undefined) ev.input = input;
    if (locations?.length) ev.locations = locations;
    this.emit(ev);
  }

  private doneTool(id: string, status: 'completed' | 'failed', output?: string, diffs?: FileDiff[]) {
    const t = this.tools.get(id);
    if (!t || t.done) return;
    t.done = true;
    const ev: Extract<AgentEvent, { type: 'tool.done' }> = { type: 'tool.done', id, status };
    if (output) ev.output = output;
    if (diffs?.length) ev.diffs = diffs;
    this.emit(ev);
  }

  private finishTurn(stopReason: string) {
    this.closeMessages();
    for (const [id, t] of this.tools) if (!t.done) this.doneTool(id, 'failed');
    this.cancelApprovals();
    if (!this.turnActive) return;
    this.turnActive = false;
    this.turnId = null;
    this.emit({ type: 'turn.done', stopReason });
  }

  protected override onProcessExit(): void {
    this.approvals.clear();
    if (this.turnActive) {
      this.turnActive = false;
      this.closeMessages();
      this.emit({ type: 'turn.done', stopReason: 'exited' });
    }
  }

  // ---- client → server ----------------------------------------------------------------

  async prompt(text: string, images?: ImageInput[]): Promise<void> {
    await this.ready;
    if (!this.threadId) throw new Error('Kein Thread');
    const input: cx.UserInput[] = [];
    for (const img of images ?? []) input.push({ type: 'image', url: `data:${img.mime};base64,${img.data}` });
    input.push({ type: 'text', text, text_elements: [] });
    this.tools.clear();
    this.reasoningSummary.clear();
    this.turnErrorReported = false;
    this.turnActive = true;
    try {
      const res = await this.rpc.request<cx.TurnStartResponse>('turn/start', {
        threadId: this.threadId,
        input,
        approvalPolicy: this.policy,
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(this.model ? { model: this.model } : {}),
      } satisfies cx.TurnStartParams);
      this.turnId = res?.turn?.id ?? this.turnId;
    } catch (err) {
      this.turnActive = false;
      throw err;
    }
  }

  async cancel(): Promise<void> {
    this.cancelApprovals();
    if (!this.threadId || !this.turnActive) return;
    if (!this.turnId) return;
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 15_000).catch(() => undefined);
  }

  async setMode(mode: string): Promise<void> {
    if (!CODEX_MODES.some((m) => m.id === mode)) throw new Error(`Unbekannter Modus: ${mode}`);
    this.mode = mode;
    this.updateInfo({ currentMode: mode });
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    this.updateInfo({ currentModel: model });
  }
}

function legacyDecision(d: cx.ApprovalDecision): unknown {
  switch (d) {
    case 'accept':
      return 'approved';
    case 'acceptForSession':
      return 'approved_for_session';
    case 'decline':
      return { denied: { rejection: 'Vom Nutzer abgelehnt' } };
    default:
      return 'abort';
  }
}

function mcpResultText(result: { content?: unknown[] } | null): string | undefined {
  if (!result?.content) return undefined;
  const parts = result.content.map((c) => {
    const b = c as { type?: string; text?: string };
    return b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(c);
  });
  return parts.join('\n') || undefined;
}

export const CodexAppServerAdapter: AgentAdapter = {
  start(opts: AgentStartOptions): AgentSessionHandle {
    return new CodexSession(opts);
  },
};
