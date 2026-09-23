// Agent Client Protocol (https://agentclientprotocol.com) client side.
// Types come from the official SDK (`@agentclientprotocol/sdk`, type-only import); the wire
// handling is our own small JSON-RPC peer so that unknown/legacy fields from the many ACP
// agents (claude-agent-acp, opencode, cline, kilo, gemini) never fail schema validation.

import fs from 'node:fs/promises';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentEvent, ApprovalOption, FileDiff, ImageInput, PlanEntry, QuestionAnswers, QuestionField, ToolKind } from '@vibe/shared';
import { BaseSession, newId } from './base.js';
import { answersToContent, schemaToFields, type ElicitationResponse, type FormElicitation } from './elicitation.js';
import { RpcError } from './jsonrpc.js';
import type { AgentAdapter, AgentSessionHandle, AgentStartOptions } from './types.js';

const PROTOCOL_VERSION = 1;

/** Legacy (pre-1.0, "unstable") model state some agents still return from session/new. */
interface LegacyModelState {
  currentModelId?: string;
  availableModels?: { modelId: string; name?: string; description?: string | null }[];
}

function mapToolKind(kind: acp.ToolKind | null | undefined): ToolKind {
  switch (kind) {
    case 'execute':
      return 'exec';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    case 'fetch':
      return 'fetch';
    case 'think':
      return 'think';
    default:
      return 'other';
  }
}

function contentText(block: acp.ContentBlock | undefined): string {
  if (!block) return '';
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return block.uri;
    case 'resource':
      return 'text' in block.resource ? block.resource.text : '';
    default:
      return '';
  }
}

function flattenSelect(opts: acp.SessionConfigSelectOptions): acp.SessionConfigSelectOption[] {
  const out: acp.SessionConfigSelectOption[] = [];
  for (const o of opts as (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[]) {
    if ('group' in o) out.push(...o.options);
    else out.push(o);
  }
  return out;
}

interface ToolState {
  output: string;
  kind: ToolKind;
  done: boolean;
  lastUpdate?: string;
}

interface PendingApproval {
  resolve: (r: acp.RequestPermissionResponse) => void;
  options: acp.PermissionOption[];
}

/** `_meta.claudeCode.parentToolUseId` of an update (set by claude-agent-acp for sub-agent / side-query output). */
function parentToolUseId(u: { _meta?: unknown }): string | null {
  const meta = (u._meta as { claudeCode?: { parentToolUseId?: unknown } } | null | undefined)?.claudeCode;
  return typeof meta?.parentToolUseId === 'string' ? meta.parentToolUseId : null;
}

export class AcpSession extends BaseSession {
  private sessionId: string | null = null;
  private caps: acp.AgentCapabilities = {};
  private configOptions: acp.SessionConfigOption[] = [];
  private legacyModels: LegacyModelState | null = null;
  private readonly tools = new Map<string, ToolState>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** Open questions (form elicitations) waiting for the user's answer. */
  private readonly questions = new Map<string, { fields: QuestionField[]; resolve: (r: ElicitationResponse) => void }>();
  private turnActive = false;
  /** Updates are suppressed while session/load replays the history (we already have it). */
  private replaying = false;

  constructor(opts: AgentStartOptions) {
    super(opts);
    this.rpc.onNotification = (method, params) => {
      if (method === 'session/update') this.onUpdate(params as acp.SessionNotification);
    };
    this.rpc.onRequest = (method, params) => this.onAgentRequest(method, params);
  }

  protected async handshake(): Promise<void> {
    const init = await this.rpc.request<acp.InitializeResponse>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // `elicitation.form`: we render agent questions (Claude Code only enables AskUserQuestion with it).
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, elicitation: { form: {} }, session: { notices: {} } } as acp.ClientCapabilities,
      clientInfo: { name: this.opts.clientName ?? 'agentforge', title: 'Agentforge', version: this.opts.clientVersion ?? '0.1.0' },
    } satisfies acp.InitializeRequest);
    this.caps = init.agentCapabilities ?? {};

    const mcpServers: acp.McpServerStdio[] = (this.opts.mcpServers ?? []).map((m) => ({
      name: m.name,
      command: m.command,
      args: m.args,
      env: Object.entries(m.env).map(([name, value]) => ({ name, value })),
    }));
    const cwd = this.opts.cwd;
    let resp: { sessionId?: string; modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null; models?: LegacyModelState | null } | null = null;
    const resumeId = this.opts.resumeExternalId;
    if (resumeId) {
      try {
        if (this.caps.sessionCapabilities?.resume) {
          resp = await this.rpc.request('session/resume', { sessionId: resumeId, cwd, mcpServers } satisfies acp.ResumeSessionRequest);
          this.sessionId = resumeId;
        } else if (this.caps.loadSession) {
          this.replaying = true;
          try {
            resp = await this.rpc.request('session/load', { sessionId: resumeId, cwd, mcpServers } satisfies acp.LoadSessionRequest);
          } finally {
            this.replaying = false;
          }
          this.sessionId = resumeId;
        } else {
          this.emit({ type: 'error', message: 'Der Agent unterstützt kein Fortsetzen – es wurde eine neue Sitzung gestartet (bisheriger Verlauf ist dem Agent nicht bekannt).' });
        }
      } catch (err) {
        this.emit({ type: 'error', message: `Fortsetzen fehlgeschlagen (${(err as Error).message}) – neue Sitzung gestartet.` });
        resp = null;
      }
    }
    if (!this.sessionId) {
      resp = await this.rpc.request<acp.NewSessionResponse>('session/new', { cwd, mcpServers } satisfies acp.NewSessionRequest);
      if (!resp?.sessionId) throw new Error('Agent hat keine Session-ID geliefert');
      this.sessionId = resp.sessionId;
    }
    this.applySessionState(resp);

    if (this.opts.model && this.opts.model !== this.info.currentModel) {
      await this.setModel(this.opts.model).catch((e: Error) => this.emit({ type: 'error', message: `Modell konnte nicht gesetzt werden: ${e.message}` }));
    }
    if (this.opts.mode && this.opts.mode !== this.info.currentMode) {
      await this.setMode(this.opts.mode).catch((e: Error) => this.emit({ type: 'error', message: `Modus konnte nicht gesetzt werden: ${e.message}` }));
    }
    // externalId last: session.info is only emitted from here on (one snapshot for the handshake).
    this.externalId = this.sessionId;
    this.updateInfo({});
  }

  private applySessionState(resp: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null; models?: LegacyModelState | null } | null) {
    if (!resp) return;
    if (resp.configOptions) this.configOptions = resp.configOptions;
    if (resp.models) this.legacyModels = resp.models;
    const patch: Parameters<BaseSession['updateInfo']>[0] = {};
    if (resp.modes) {
      patch.modes = resp.modes.availableModes.map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }));
      patch.currentMode = resp.modes.currentModeId;
    }
    Object.assign(patch, this.infoFromConfig());
    if (!patch.models && this.legacyModels?.availableModels) {
      patch.models = this.legacyModels.availableModels.map((m) => ({ id: m.modelId, name: m.name ?? m.modelId }));
      patch.currentModel = this.legacyModels.currentModelId ?? null;
    }
    this.info = { ...this.info, ...patch };
  }

  /** Models/modes from the (1.x) session config options. */
  private infoFromConfig(): Parameters<BaseSession['updateInfo']>[0] {
    const patch: Parameters<BaseSession['updateInfo']>[0] = {};
    for (const o of this.configOptions) {
      if (o.type !== 'select') continue;
      const opts = flattenSelect(o.options);
      if (o.category === 'model') {
        patch.models = opts.map((v) => ({ id: v.value, name: v.name }));
        patch.currentModel = o.currentValue;
      } else if (o.category === 'mode' && !this.info.modes) {
        patch.modes = opts.map((v) => ({ id: v.value, name: v.name, ...(v.description ? { description: v.description } : {}) }));
        patch.currentMode = o.currentValue;
      }
    }
    return patch;
  }

  // ---- agent → client requests ---------------------------------------------

  private async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'session/request_permission':
        return this.requestPermission(params as acp.RequestPermissionRequest);
      case 'elicitation/create':
        return this.askQuestion(params as FormElicitation);
      case 'fs/read_text_file': {
        const p = params as acp.ReadTextFileRequest;
        const abs = path.resolve(this.opts.cwd, p.path);
        let content = await fs.readFile(abs, 'utf8');
        if (p.line || p.limit) {
          const lines = content.split('\n');
          const start = Math.max((p.line ?? 1) - 1, 0);
          content = lines.slice(start, p.limit ? start + p.limit : undefined).join('\n');
        }
        return { content } satisfies acp.ReadTextFileResponse;
      }
      case 'fs/write_text_file': {
        const p = params as acp.WriteTextFileRequest;
        const abs = path.resolve(this.opts.cwd, p.path);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, p.content, 'utf8');
        return {};
      }
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  private requestPermission(p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    this.closeMessages();
    const id = newId();
    const tc = p.toolCall;
    const kind = mapToolKind(tc.kind ?? this.tools.get(tc.toolCallId)?.kind as acp.ToolKind | undefined);
    const diffs = this.diffsOf(tc.content);
    const raw = tc.rawInput as Record<string, unknown> | undefined;
    const detail =
      typeof raw?.command === 'string'
        ? raw.command
        : Array.isArray(raw?.command)
          ? (raw.command as string[]).join(' ')
          : (tc.content ?? []).map((c) => (c.type === 'content' ? contentText(c.content) : '')).filter(Boolean).join('\n') || undefined;
    const options: ApprovalOption[] = p.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind }));
    const toolKind = this.tools.get(tc.toolCallId)?.kind;
    const approvalKind = kind === 'exec' || toolKind === 'exec' ? 'exec' : kind === 'edit' || toolKind === 'edit' || diffs.length ? 'edit' : 'other';
    return new Promise((resolve) => {
      this.approvals.set(id, { resolve, options: p.options });
      this.emit({
        type: 'approval.request',
        id,
        toolId: tc.toolCallId,
        kind: approvalKind,
        title: tc.title ?? 'Berechtigung erforderlich',
        ...(detail ? { detail } : {}),
        ...(diffs.length ? { diffs } : {}),
        options,
      });
    });
  }

  private askQuestion(p: FormElicitation): Promise<ElicitationResponse> {
    // URL-mode elicitations (MCP OAuth) are not supported; the agent handles the decline.
    if (p.mode && p.mode !== 'form') return Promise.resolve({ action: 'decline' });
    const fields = schemaToFields(p);
    if (!fields.length) return Promise.resolve({ action: 'decline' });
    this.closeMessages();
    const id = newId();
    return new Promise((resolve) => {
      this.questions.set(id, { fields, resolve });
      this.emit({
        type: 'question.request',
        id,
        ...(p.toolCallId ? { toolId: p.toolCallId } : {}),
        message: p.message ?? 'Der Agent hat eine Frage',
        fields,
      });
    });
  }

  respondQuestion(requestId: string, action: 'accept' | 'decline' | 'cancel', answers?: QuestionAnswers): void {
    const q = this.questions.get(requestId);
    if (!q) throw new Error('Unbekannte oder bereits beantwortete Frage');
    this.questions.delete(requestId);
    if (action === 'accept') {
      const content = answersToContent(q.fields, answers);
      q.resolve({ action: 'accept', content });
      this.emit({ type: 'question.resolved', id: requestId, action, answers: content });
    } else {
      q.resolve({ action });
      this.emit({ type: 'question.resolved', id: requestId, action });
    }
  }

  private cancelQuestions() {
    for (const [id, q] of this.questions) {
      q.resolve({ action: 'cancel' });
      this.emit({ type: 'question.resolved', id, action: 'cancel' });
    }
    this.questions.clear();
  }

  respondApproval(requestId: string, optionId: string): void {
    const a = this.approvals.get(requestId);
    if (!a) throw new Error('Unbekannte oder bereits beantwortete Anfrage');
    this.approvals.delete(requestId);
    if (optionId === 'cancelled' || !a.options.some((o) => o.optionId === optionId)) {
      a.resolve({ outcome: { outcome: 'cancelled' } });
      this.emit({ type: 'approval.resolved', id: requestId, optionId: 'cancelled' });
      return;
    }
    a.resolve({ outcome: { outcome: 'selected', optionId } });
    this.emit({ type: 'approval.resolved', id: requestId, optionId });
  }

  private cancelApprovals() {
    for (const [id, a] of this.approvals) {
      a.resolve({ outcome: { outcome: 'cancelled' } });
      this.emit({ type: 'approval.resolved', id, optionId: 'cancelled' });
    }
    this.approvals.clear();
  }

  protected override onProcessExit(): void {
    this.approvals.clear();
    this.questions.clear();
    if (this.turnActive) {
      this.turnActive = false;
      this.closeMessages();
      this.emit({ type: 'turn.done', stopReason: 'exited' });
    }
  }

  // ---- session/update --------------------------------------------------------

  private diffsOf(content: acp.ToolCallContent[] | null | undefined): FileDiff[] {
    const out: FileDiff[] = [];
    for (const c of content ?? []) {
      if (c.type === 'diff') out.push({ path: this.rel(c.path), oldText: c.oldText ?? null, newText: c.newText ?? null });
    }
    return out;
  }

  private textOf(content: acp.ToolCallContent[] | null | undefined): string | undefined {
    const parts = (content ?? []).filter((c) => c.type === 'content').map((c) => contentText((c as { content: acp.ContentBlock }).content));
    return parts.length ? parts.join('\n') : undefined;
  }

  /** Appends side output (e.g. a sub-agent's text) to a running tool card; unknown tools drop it. */
  private appendToolOutput(toolCallId: string, text: string, thought: boolean) {
    const t = this.tools.get(toolCallId);
    if (!t || !text || thought) return; // sub-agent thinking is noise in the parent card
    t.output += text;
    this.emit({ type: 'tool.update', id: toolCallId, output: text });
  }

  private onUpdate(n: acp.SessionNotification) {
    if (this.replaying) return;
    if (this.sessionId && n.sessionId && n.sessionId !== this.sessionId) return;
    const u = n.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        // Text of sub-agents / side queries (Claude Code: Task tool, web search, auto-mode classifier) carries
        // _meta.claudeCode.parentToolUseId. It is not the answer — attach it to that tool card instead.
        const parent = parentToolUseId(u);
        if (parent) {
          this.appendToolOutput(parent, contentText(u.content), u.sessionUpdate === 'agent_thought_chunk');
          break;
        }
        this.delta(u.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'thought', contentText(u.content), u.messageId);
        break;
      }
      case 'user_message_chunk':
        break;
      case 'tool_call':
        this.onToolCall(u);
        break;
      case 'tool_call_update':
        this.onToolUpdate(u);
        break;
      case 'plan':
        this.emit({
          type: 'plan',
          entries: u.entries.map((e): PlanEntry => ({ text: e.content, status: e.status })),
        });
        break;
      case 'available_commands_update':
        this.updateInfo({ commands: u.availableCommands.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}) })) });
        break;
      case 'current_mode_update':
        this.updateInfo({ currentMode: u.currentModeId });
        break;
      case 'config_option_update':
        this.configOptions = u.configOptions;
        this.updateInfo(this.infoFromConfig());
        break;
      case 'usage_update':
        this.emit({
          type: 'usage',
          ...(u.size ? { contextPercent: Math.round((u.used / u.size) * 1000) / 10 } : {}),
          ...(u.cost && u.cost.currency.toUpperCase() === 'USD' ? { costUsd: u.cost.amount } : {}),
        });
        break;
      case 'notice':
        // Runtime notices (`session.notices` capability): advisories that are not part of the answer.
        if (u.severity === 'error') this.emit({ type: 'error', message: u.description ? `${u.title}: ${u.description}` : u.title });
        else {
          this.closeMessages();
          this.emit({
            type: 'notice',
            severity: u.severity === 'warning' ? 'warning' : 'info',
            title: u.title,
            ...(u.description ? { description: u.description } : {}),
          });
        }
        break;
      default:
        break;
    }
  }

  private onToolCall(u: acp.ToolCall) {
    this.closeMessages();
    const kind = mapToolKind(u.kind);
    const existing = this.tools.get(u.toolCallId);
    if (existing) {
      // Some agents re-send tool_call for the same id; treat as update.
      this.onToolUpdate(u);
      return;
    }
    this.tools.set(u.toolCallId, { output: '', kind, done: false });
    const locations = u.locations?.map((l) => this.rel(l.path));
    this.emit({
      type: 'tool.start',
      id: u.toolCallId,
      kind,
      title: u.title,
      ...(u.rawInput !== undefined ? { input: u.rawInput } : {}),
      ...(locations?.length ? { locations } : {}),
    });
    if (u.content?.length || (u.status && u.status !== 'pending')) this.onToolUpdate(u);
  }

  private onToolUpdate(u: acp.ToolCallUpdate) {
    let t = this.tools.get(u.toolCallId);
    if (!t) {
      // Update for an unknown tool (e.g. announced before a resume) — synthesize a start.
      t = { output: '', kind: mapToolKind(u.kind ?? undefined), done: false };
      this.tools.set(u.toolCallId, t);
      this.emit({ type: 'tool.start', id: u.toolCallId, kind: t.kind, title: u.title ?? 'Werkzeug' });
    }
    if (t.done) return;
    const diffs = u.content ? this.diffsOf(u.content) : [];
    const text = u.content ? this.textOf(u.content) : undefined;
    const rawOut = typeof u.rawOutput === 'string' ? u.rawOutput : undefined;
    const full = text ?? rawOut;

    if (u.status === 'completed' || u.status === 'failed') {
      t.done = true;
      this.emit({
        type: 'tool.done',
        id: u.toolCallId,
        status: u.status,
        ...(full !== undefined ? { output: full } : t.output ? { output: t.output } : {}),
        ...(diffs.length ? { diffs } : {}),
      });
      return;
    }
    // ACP replaces the content collection on each update; our tool.update.output is
    // append-only, so only forward the grown suffix (the rest arrives with tool.done).
    let append: string | undefined;
    if (full !== undefined && full.length > t.output.length && full.startsWith(t.output)) {
      append = full.slice(t.output.length);
      t.output = full;
    }
    const locations = u.locations?.map((l) => this.rel(l.path));
    const ev: Extract<AgentEvent, { type: 'tool.update' }> = { type: 'tool.update', id: u.toolCallId };
    if (u.status) ev.status = u.status === 'in_progress' ? 'running' : 'pending';
    if (u.title) ev.title = u.title;
    if (append) ev.output = append;
    if (diffs.length) ev.diffs = diffs;
    if (locations?.length) ev.locations = locations;
    if (Object.keys(ev).length <= 2) return;
    // Agents often repeat identical updates (e.g. status pings); only forward changes.
    const key = JSON.stringify({ ...ev, output: undefined });
    if (!ev.output && key === t.lastUpdate) return;
    t.lastUpdate = key;
    this.emit(ev);
  }

  // ---- client → agent ----------------------------------------------------------

  async prompt(text: string, images?: ImageInput[]): Promise<void> {
    await this.ready;
    if (!this.sessionId) throw new Error('Keine Sitzung');
    const blocks: acp.ContentBlock[] = [];
    if (images?.length) {
      if (this.caps.promptCapabilities?.image) {
        for (const img of images) blocks.push({ type: 'image', data: img.data, mimeType: img.mime });
      } else {
        this.emit({ type: 'error', message: 'Dieser Agent unterstützt keine Bilder – Bilder wurden nicht gesendet.' });
      }
    }
    blocks.push({ type: 'text', text });
    this.turnActive = true;
    this.tools.clear();
    this.rpc
      .request<acp.PromptResponse>('session/prompt', { sessionId: this.sessionId, prompt: blocks } satisfies acp.PromptRequest)
      .then(
        (res) => {
          this.closeMessages();
          if (res?.usage) this.emit({ type: 'usage', inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens });
          this.finishTurn(res?.stopReason ?? 'end_turn');
        },
        (err: Error) => {
          this.closeMessages();
          if (!this.rpc.alive) return; // onProcessExit emits turn.done
          this.emit({ type: 'error', message: err.message });
          this.finishTurn('error');
        },
      );
  }

  private finishTurn(stopReason: string) {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.cancelApprovals();
    this.cancelQuestions();
    // Tools the agent never finished (e.g. on cancel) are closed so the UI stops spinning.
    for (const [id, t] of this.tools) {
      if (!t.done) {
        t.done = true;
        this.emit({ type: 'tool.done', id, status: 'failed' });
      }
    }
    this.emit({ type: 'turn.done', stopReason });
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) return;
    this.cancelApprovals();
    this.cancelQuestions();
    this.rpc.notify('session/cancel', { sessionId: this.sessionId } satisfies acp.CancelNotification);
  }

  async setMode(mode: string): Promise<void> {
    if (!this.sessionId) throw new Error('Keine Sitzung');
    const cfg = this.configOptions.find((o) => o.category === 'mode' && o.type === 'select');
    if (!this.info.modes && cfg) {
      const res = await this.rpc.request<acp.SetSessionConfigOptionResponse>('session/set_config_option', { sessionId: this.sessionId, configId: cfg.id, value: mode });
      if (res?.configOptions) this.configOptions = res.configOptions;
      this.updateInfo({ ...this.infoFromConfig(), currentMode: mode });
      return;
    }
    await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: mode } satisfies acp.SetSessionModeRequest);
    this.updateInfo({ currentMode: mode });
  }

  async setModel(model: string): Promise<void> {
    if (!this.sessionId) throw new Error('Keine Sitzung');
    const cfg = this.configOptions.find((o) => o.category === 'model' && o.type === 'select');
    if (cfg) {
      const res = await this.rpc.request<acp.SetSessionConfigOptionResponse>('session/set_config_option', { sessionId: this.sessionId, configId: cfg.id, value: model });
      if (res?.configOptions) this.configOptions = res.configOptions;
      this.updateInfo({ ...this.infoFromConfig(), currentModel: model });
      return;
    }
    // Pre-1.0 agents: unstable `session/set_model`.
    await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: model });
    this.updateInfo({ currentModel: model });
  }
}

export const AcpAdapter: AgentAdapter = {
  start(opts: AgentStartOptions): AgentSessionHandle {
    return new AcpSession(opts);
  },
};
