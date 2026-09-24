import type {
  AgentEvent,
  AgentSession,
  ApprovalPolicy,
  AgentStartParams,
  CreateSessionRequest,
  ImageInput,
  McpServerSpec,
  QuestionResponse,
  SessionEventRecord,
  SessionStatus,
  StructuredTransport,
  WsdNotifications,
} from '@vibe/shared';
import { AGENTFORGE_MCP_NAME, getAgentManifest } from '@vibe/shared';
import { ulid } from 'ulid';
import { buildStructuredLaunch } from '../agents/launch.js';
import type { AppContext } from '../app-context.js';
import { githubService } from '../github/service.js';
import { nowIso, type Db } from '../db/index.js';
import { bus } from '../events.js';
import { providerRepo } from '../routes/providers.js';
import { HttpError } from '../workspaces/manager.js';
import type { WsdClient } from '../workspaces/wsd-client.js';
import { WsdError } from '../workspaces/wsd-client.js';
import { autoApproval, openApprovals } from './approval-policy.js';

export const DEFAULT_TITLE = 'Neue Sitzung';
const TITLE_MAX = 60;
export const CHAT_SETTING_KEY = 'allowClaudeSubscriptionChat';

/** Playwright MCP from the workspace image (`@playwright/mcp`, bin `playwright-mcp`). */
/** Agentforge board tools (tasks + status, milestones, notes) for the agent of one chat session. */
export const agentforgeMcp = (sessionId: string): McpServerSpec => ({
  name: AGENTFORGE_MCP_NAME,
  command: 'agentforge-mcp',
  args: [],
  env: { AGENTFORGE_SESSION_ID: sessionId },
});

export const PLAYWRIGHT_MCP: McpServerSpec = {
  name: 'playwright',
  command: 'playwright-mcp',
  args: ['--headless', '--isolated', '--browser', 'chromium'],
  env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' },
};

export interface SessionRow {
  id: string;
  project_id: string;
  agent_id: string;
  profile_id: string | null;
  transport: StructuredTransport;
  title: string;
  status: SessionStatus;
  status_message: string | null;
  external_id: string | null;
  cwd: string;
  task_run_id: string | null;
  current_model: string | null;
  current_mode: string | null;
  provider_model?: string | null;
  provider_models_json?: string | null;
  approval_policy?: ApprovalPolicy;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

export const toSession = (r: SessionRow): AgentSession => ({
  id: r.id,
  projectId: r.project_id,
  agentId: r.agent_id,
  profileId: r.profile_id,
  transport: r.transport,
  title: r.title,
  status: r.status,
  statusMessage: r.status_message,
  externalId: r.external_id,
  cwd: r.cwd,
  taskRunId: r.task_run_id,
  currentModel: r.current_model,
  currentMode: r.current_mode,
  approvalPolicy: r.approval_policy ?? 'ask',
  providerModels: r.provider_models_json ? (JSON.parse(r.provider_models_json) as string[]) : null,
  providerModel: r.provider_model ?? null,
  lastSeq: r.last_seq,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Title derived from the first user message. */
export function autoTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return DEFAULT_TITLE;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

const FINISHED: SessionStatus[] = ['stopped', 'error'];

type Log = { info: (m: string) => void; warn: (m: string) => void };

/**
 * Event persistence for structured agent sessions. Pure DB + bus logic (unit-tested with an
 * in-memory Db); the wsd wiring lives in SessionService.
 */
export class SessionStore {
  constructor(readonly db: Db) {}

  row(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>('SELECT * FROM agent_sessions WHERE id = ?', id);
  }

  require(id: string): SessionRow {
    const r = this.row(id);
    if (!r) throw new HttpError(404, 'not_found', 'Sitzung nicht gefunden');
    return r;
  }

  list(projectId: string): AgentSession[] {
    return this.db
      .all<SessionRow>('SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC', projectId)
      .map(toSession);
  }

  events(sessionId: string, since: number): SessionEventRecord[] {
    return this.db
      .all<{ seq: number; ts: string; payload_json: string }>(
        'SELECT seq, ts, payload_json FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq',
        sessionId,
        since,
      )
      .map((r) => ({ seq: r.seq, ts: r.ts, event: JSON.parse(r.payload_json) as AgentEvent }));
  }

  /** Updates columns, bumps updated_at and publishes session.updated. */
  patch(
    id: string,
    patch: Partial<
      Pick<SessionRow, 'title' | 'status' | 'status_message' | 'external_id' | 'current_model' | 'current_mode' | 'provider_model' | 'provider_models_json' | 'approval_policy'>
    >,
  ): SessionRow | undefined {
    this.db.update('agent_sessions', id, { ...patch, updated_at: nowIso() });
    const row = this.row(id);
    if (row) bus.project(row.project_id, { type: 'session.updated', projectId: row.project_id, session: toSession(row) });
    return row;
  }

  /**
   * Persists one agent.event (idempotent on (session_id, seq)), updates the session row and
   * publishes live events. Returns false for duplicates / unknown sessions.
   */
  ingest(projectId: string, sessionId: string, rec: SessionEventRecord): boolean {
    const e = rec.event;
    let changed = false;
    let row: SessionRow | undefined;
    const inserted = this.db.tx(() => {
      row = this.db.get<SessionRow>('SELECT * FROM agent_sessions WHERE id = ? AND project_id = ?', sessionId, projectId);
      if (!row) return false;
      const res = this.db.run(
        'INSERT OR IGNORE INTO session_events (session_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)',
        sessionId,
        rec.seq,
        rec.ts,
        e.type,
        JSON.stringify(e),
      );
      if (Number(res.changes) === 0) return false;

      const upd: Record<string, string | number | null> = {};
      switch (e.type) {
        case 'status':
          if (row.status !== e.status || row.status_message !== (e.message ?? null)) {
            upd.status = e.status;
            upd.status_message = e.message ?? null;
          }
          break;
        case 'session.info':
          if (e.externalId && e.externalId !== row.external_id) upd.external_id = e.externalId;
          if (e.currentModel !== undefined && e.currentModel !== row.current_model) upd.current_model = e.currentModel;
          if (e.currentMode !== undefined && e.currentMode !== row.current_mode) upd.current_mode = e.currentMode;
          break;
        case 'user.message':
          if (row.title === DEFAULT_TITLE) upd.title = autoTitle(e.text);
          upd.updated_at = nowIso(); // activity sorts the session list
          break;
        case 'message.done':
          // The done event carries the full text; drop the streamed deltas to keep the log small.
          this.db.run(
            "DELETE FROM session_events WHERE session_id = ? AND type = 'message.delta' AND json_extract(payload_json, '$.id') = ? AND json_extract(payload_json, '$.role') = ?",
            sessionId,
            e.id,
            e.role,
          );
          break;
        case 'tool.done':
          if (e.output !== undefined) {
            this.db.run(
              `DELETE FROM session_events WHERE session_id = ? AND type = 'tool.update' AND json_extract(payload_json, '$.id') = ?
                 AND json_extract(payload_json, '$.output') IS NOT NULL AND json_extract(payload_json, '$.status') IS NULL
                 AND json_extract(payload_json, '$.diffs') IS NULL AND json_extract(payload_json, '$.title') IS NULL`,
              sessionId,
              e.id,
            );
          }
          break;
        default:
          break;
      }
      changed = Object.keys(upd).some((k) => k !== 'updated_at');
      if (changed) upd.updated_at = nowIso();
      const sets = Object.keys(upd).map((k) => `${k} = ?`);
      this.db.run(
        `UPDATE agent_sessions SET last_seq = MAX(last_seq, ?)${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = ?`,
        rec.seq,
        ...Object.values(upd),
        sessionId,
      );
      return true;
    });
    if (!inserted) return false;
    bus.publish(`session:${sessionId}`, { type: 'session.event', sessionId, seq: rec.seq, ts: rec.ts, event: e });
    if (changed) {
      const r = this.row(sessionId);
      if (r) bus.project(projectId, { type: 'session.updated', projectId, session: toSession(r) });
    }
    return true;
  }

  /** Process of a session ended (agent.exit or vanished after a workspace restart). */
  markStopped(sessionId: string, message: string | null) {
    const row = this.row(sessionId);
    if (!row || FINISHED.includes(row.status)) return;
    this.patch(sessionId, { status: 'stopped', status_message: message });
  }
}

/** Service behind routes/sessions.ts: DB + workspace daemon + agent launch policy. */
export class SessionService {
  readonly store: SessionStore;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: Log,
  ) {
    this.store = new SessionStore(ctx.db);
  }

  /** Hooks into wsd notifications and connection events. */
  attach() {
    this.ctx.workspaces.onWsdNotification((projectId, method, params) => {
      if (method === 'agent.event') {
        const p = params as WsdNotifications['agent.event'];
        if (this.store.ingest(projectId, p.sessionId, { seq: p.seq, ts: p.ts, event: p.event }) && p.event.type === 'approval.request') {
          this.autoApprove(p.sessionId, [p.event]);
        }
      } else if (method === 'agent.exit') {
        const p = params as WsdNotifications['agent.exit'];
        const row = this.store.row(p.sessionId);
        if (row && row.project_id === projectId) this.store.markStopped(p.sessionId, p.message ?? null);
      }
    });
    this.ctx.workspaces.onConnected((projectId, client) => this.resync(projectId, client));
  }

  /** Backfills events missed while the app was away and marks vanished agent processes. */
  async resync(projectId: string, client: WsdClient) {
    const rows = this.ctx.db.all<SessionRow>('SELECT * FROM agent_sessions WHERE project_id = ?', projectId);
    if (!rows.length) return;
    const states = await client.call('agent.list', {});
    for (const row of rows) {
      const st = states.find((s) => s.sessionId === row.id);
      if (!st) {
        this.store.markStopped(row.id, FINISHED.includes(row.status) ? row.status_message : 'Agent-Prozess nicht mehr vorhanden (Workspace neu gestartet)');
        continue;
      }
      if (st.lastSeq > row.last_seq) {
        const events = await client.call('agent.events', { sessionId: row.id, since: row.last_seq });
        if (events.length && events[0]!.seq > row.last_seq + 1) {
          this.log.warn(`Sitzung ${row.id}: Ereignisse ${row.last_seq + 1}–${events[0]!.seq - 1} nicht mehr im wsd-Puffer`);
        }
        let n = 0;
        for (const rec of events) if (this.store.ingest(projectId, row.id, rec)) n++;
        if (n) this.log.info(`Sitzung ${row.id}: ${n} Ereignisse nachgeladen`);
        if (n && st.running) this.autoApprove(row.id, this.pendingApprovals(row.id));
      }
      if (!st.running) this.store.markStopped(row.id, null);
    }
  }

  // ---- settings -------------------------------------------------------------------

  chatSettings(): { allowClaudeSubscriptionChat: boolean } {
    const r = this.ctx.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', CHAT_SETTING_KEY);
    let v = false;
    try {
      v = r ? JSON.parse(r.value_json) === true : false;
    } catch {
      v = false;
    }
    return { allowClaudeSubscriptionChat: v };
  }

  setChatSettings(s: { allowClaudeSubscriptionChat: boolean }) {
    this.ctx.db.run(
      'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      CHAT_SETTING_KEY,
      JSON.stringify(s.allowClaudeSubscriptionChat),
    );
    return this.chatSettings();
  }

  // ---- launch -------------------------------------------------------------------------

  private async launchParams(
    row: Pick<SessionRow, 'id' | 'agent_id' | 'profile_id' | 'cwd' | 'last_seq' | 'external_id' | 'current_model' | 'current_mode' | 'provider_model'>,
    resume: boolean,
  ): Promise<AgentStartParams> {
    const repo = providerRepo(this.ctx);
    const profile = row.profile_id ? repo.profile(row.profile_id) : null;
    if (row.profile_id && !profile) throw new HttpError(400, 'invalid_profile', 'Profil nicht gefunden');
    if (profile && profile.agentKind !== row.agent_id) throw new HttpError(400, 'invalid_profile', 'Das Profil gehört zu einem anderen Agent');
    if (row.agent_id === 'claude' && profile?.authMode !== 'provider' && !this.chatSettings().allowClaudeSubscriptionChat) {
      throw new HttpError(
        400,
        'claude_subscription_chat',
        'Anthropic erlaubt die Nutzung eines Claude-Abos (Pro/Max) nicht in Drittanbieter-Apps. Nutze Claude Code im Terminal (Agent starten → Claude Code) oder lege ein Profil mit API-Schlüssel an. Die Sperre lässt sich in den Einstellungen auf eigene Verantwortung aufheben.',
      );
    }
    const provider = profile?.providerId ? repo.get(profile.providerId) : null;
    const creds = profile?.authMode === 'provider' ? await repo.credentials(provider) : { apiKey: null, chatgpt: null };
    let launch;
    try {
      launch = buildStructuredLaunch(row.agent_id, { profile, provider, ...creds, modelOverride: row.provider_model ?? null });
    } catch (err) {
      throw new HttpError(400, 'invalid_agent', (err as Error).message);
    }
    return {
      sessionId: row.id,
      agentId: row.agent_id,
      transport: launch.transport,
      command: launch.command,
      args: launch.args,
      cwd: row.cwd,
      env: this.withGitHubToken(row.agent_id, launch.env),
      // Provider sessions: the model is part of the launch (env/config); the agent's own ids don't apply.
      model: this.providerModels(row) ? launch.model : ((resume ? row.current_model : null) ?? launch.model),
      mode: resume ? row.current_mode : null,
      mcpServers: [agentforgeMcp(row.id), PLAYWRIGHT_MCP],
      resumeExternalId: resume ? row.external_id : null,
      startSeq: row.last_seq,
    };
  }

  /**
   * Models offered in the chat picker for a session with a provider profile (null otherwise):
   * the provider's configured models plus its default and the profile model.
   */
  providerModels(row: Pick<SessionRow, 'profile_id' | 'provider_model'>): { models: string[]; selected: string | null } | null {
    const repo = providerRepo(this.ctx);
    const profile = row.profile_id ? repo.profile(row.profile_id) : null;
    if (profile?.authMode !== 'provider' || !profile.providerId) return null;
    const provider = repo.get(profile.providerId);
    if (!provider) return null;
    const selected = row.provider_model || profile.model || provider.defaultModel || null;
    const models = [...new Set([...provider.models, provider.defaultModel, profile.model, selected].filter((m): m is string => !!m))];
    return { models, selected };
  }

  /** Sessions of a project; rows created before provider models existed are filled in on the way. */
  listSessions(projectId: string): AgentSession[] {
    const stale = this.ctx.db.all<{ id: string }>(
      'SELECT id FROM agent_sessions WHERE project_id = ? AND profile_id IS NOT NULL AND provider_models_json IS NULL',
      projectId,
    );
    for (const r of stale) this.syncProviderModels(r.id);
    return this.store.list(projectId);
  }

  /**
   * GH_TOKEN for the `gh` CLI (process env only, like terminals). Not for Copilot: it would prefer our token
   * over its own login, which usually lacks Copilot access.
   */
  private withGitHubToken(agentId: string, env: Record<string, string>): Record<string, string> {
    if (agentId === 'copilot' || env.GH_TOKEN) return env;
    const token = githubService(this.ctx).getToken();
    return token ? { ...env, GH_TOKEN: token } : env;
  }

  /** Stores the provider model list/selection on the row so the browser sees it with the session. */
  private syncProviderModels(id: string) {
    const row = this.store.require(id);
    const pm = this.providerModels(row);
    const json = pm ? JSON.stringify(pm.models) : null;
    const selected = pm?.selected ?? null;
    if (json !== (row.provider_models_json ?? null) || selected !== (row.provider_model ?? null)) {
      this.store.patch(id, { provider_models_json: json, provider_model: selected });
    }
  }

  /** agent.start; failures land in the row as status `error` (the session stays, /resume retries). */
  private async startAgent(client: WsdClient, params: AgentStartParams): Promise<SessionRow> {
    try {
      const res = await client.call('agent.start', params);
      const row = this.store.require(params.sessionId);
      if (res.externalId && res.externalId !== row.external_id) return this.store.patch(row.id, { external_id: res.externalId }) ?? row;
      return row;
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof WsdError && /läuft bereits/.test(msg)) return this.store.require(params.sessionId);
      this.log.warn(`agent.start ${params.sessionId}: ${msg}`);
      return this.store.patch(params.sessionId, { status: 'error', status_message: msg }) ?? this.store.require(params.sessionId);
    }
  }

  async create(projectId: string, body: CreateSessionRequest): Promise<AgentSession> {
    if (!this.ctx.db.get('SELECT id FROM projects WHERE id = ?', projectId)) throw new HttpError(404, 'not_found', 'Projekt nicht gefunden');
    const manifest = getAgentManifest(body.agentId);
    if (!manifest) throw new HttpError(400, 'invalid_agent', `Unbekannter Agent: ${body.agentId}`);
    if (!manifest.structured) throw new HttpError(400, 'invalid_agent', `${manifest.label} unterstützt keine Chat-Sitzungen`);
    const id = ulid();
    const draft = {
      id,
      agent_id: body.agentId,
      profile_id: body.profileId ?? null,
      cwd: body.cwd?.trim() || '.',
      last_seq: 0,
      external_id: null,
      current_model: null,
      current_mode: null,
      provider_model: body.model?.trim() || null,
      // Explicit choice > the profile's default > ask.
      approval_policy: body.approvalPolicy ?? (body.profileId ? providerRepo(this.ctx).profile(body.profileId)?.approvalPolicy : undefined) ?? 'ask',
    };
    // Validates profile + policy before anything is created.
    const params = await this.launchParams(draft, false);
    const client = await this.ctx.workspaces.waitForClient(projectId, 5_000);
    const now = nowIso();
    this.ctx.db.insert('agent_sessions', {
      ...draft,
      project_id: projectId,
      transport: params.transport,
      title: body.title?.trim() || DEFAULT_TITLE,
      status: 'starting',
      status_message: null,
      task_run_id: null,
      current_model: params.model ?? null,
      created_at: now,
      updated_at: now,
    });
    this.syncProviderModels(id);
    const created = this.store.require(id);
    bus.project(projectId, { type: 'session.updated', projectId, session: toSession(created) });
    const row = await this.startAgent(client, params);
    if (body.initialPrompt?.trim() && row.status !== 'error') {
      await client.call('agent.prompt', { sessionId: id, text: body.initialPrompt }).catch((err: Error) => this.log.warn(`initialPrompt ${id}: ${err.message}`));
    }
    return toSession(this.store.require(id));
  }

  private async clientFor(row: SessionRow) {
    return this.ctx.workspaces.waitForClient(row.project_id, 5_000);
  }

  async resume(id: string): Promise<AgentSession> {
    this.syncProviderModels(id);
    const row = this.store.require(id);
    const params = await this.launchParams(row, true);
    const client = await this.clientFor(row);
    this.store.patch(id, { status: 'starting', status_message: null });
    await this.startAgent(client, params);
    return toSession(this.store.require(id));
  }

  async prompt(id: string, text: string, images?: ImageInput[]) {
    const row = this.store.require(id);
    const client = await this.clientFor(row);
    const send = () => client.call('agent.prompt', { sessionId: id, text, ...(images?.length ? { images } : {}) });
    try {
      await send();
    } catch (err) {
      if (!(err instanceof WsdError) || !/läuft nicht|unbekannte Sitzung/.test(err.message)) throw err;
      // Agent process is gone (stopped, crashed, workspace restarted): resume transparently.
      const resumed = await this.resume(id);
      if (resumed.status === 'error') throw new HttpError(502, 'agent_start_failed', resumed.statusMessage ?? 'Agent konnte nicht gestartet werden');
      await send();
    }
    return { ok: true as const };
  }

  private async call(
    id: string,
    method: 'agent.cancel' | 'agent.respond' | 'agent.answer' | 'agent.setMode' | 'agent.setModel',
    extra: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    const row = this.store.require(id);
    const client = await this.clientFor(row);
    try {
      return await client.call(method, { sessionId: id, ...extra } as never);
    } catch (err) {
      if (err instanceof WsdError && /läuft nicht|unbekannte Sitzung/.test(err.message)) {
        throw new HttpError(409, 'session_not_running', 'Der Agent dieser Sitzung läuft nicht – bitte fortsetzen');
      }
      throw err;
    }
  }

  cancel(id: string) {
    return this.call(id, 'agent.cancel', {});
  }

  respond(id: string, requestId: string, optionId: string) {
    return this.call(id, 'agent.respond', { requestId, optionId });
  }

  answer(id: string, body: QuestionResponse) {
    return this.call(id, 'agent.answer', { requestId: body.requestId, action: body.action, ...(body.answers ? { answers: body.answers } : {}) });
  }

  /** Changes how permission requests are answered; open requests the new policy covers are answered now. */
  setApprovalPolicy(id: string, policy: ApprovalPolicy): AgentSession {
    this.store.require(id);
    const row = this.store.patch(id, { approval_policy: policy })!;
    this.autoApprove(id, this.pendingApprovals(id));
    return toSession(row);
  }

  private pendingApprovals(id: string) {
    const rows = this.ctx.db.all<{ payload_json: string }>(
      "SELECT payload_json FROM session_events WHERE session_id = ? AND type IN ('approval.request', 'approval.resolved') ORDER BY seq",
      id,
    );
    return openApprovals(rows.map((r) => JSON.parse(r.payload_json) as AgentEvent));
  }

  /** Answers permission requests the session's approval policy allows (the rest waits for the user). */
  private autoApprove(id: string, requests: AgentEvent[]) {
    const row = this.store.row(id);
    const policy = row?.approval_policy ?? 'ask';
    if (!row || policy === 'ask') return;
    for (const e of requests) {
      if (e.type !== 'approval.request') continue;
      const optionId = autoApproval(e, policy);
      if (!optionId) continue;
      void this.respond(id, e.id, optionId).catch((err: Error) => this.log.warn(`Automatische Freigabe ${id}/${e.id}: ${err.message}`));
    }
  }

  setMode(id: string, value: string) {
    return this.call(id, 'agent.setMode', { value });
  }

  async setModel(id: string, value: string): Promise<unknown> {
    const row = this.store.require(id);
    if (!this.providerModels(row)) return this.call(id, 'agent.setModel', { value });
    // Provider sessions: the model is baked into the launch (env/config per agent), so switching means
    // restarting the agent process with the new model and resuming the same conversation.
    if (row.status === 'running' || row.status === 'awaiting_approval') {
      throw new HttpError(409, 'session_busy', 'Das Modell kann gewechselt werden, sobald der Agent fertig ist');
    }
    this.store.patch(id, { provider_model: value });
    const client = this.connectedClient(row.project_id);
    if (client && row.status !== 'stopped' && row.status !== 'error') {
      await client.call('agent.stop', { sessionId: id }).catch(() => undefined);
    }
    return this.resume(id);
  }

  async stop(id: string): Promise<AgentSession> {
    const row = this.store.require(id);
    const client = this.connectedClient(row.project_id);
    if (client) await client.call('agent.stop', { sessionId: id });
    this.store.markStopped(id, null);
    return toSession(this.store.require(id));
  }

  private connectedClient(projectId: string): WsdClient | null {
    try {
      return this.ctx.workspaces.client(projectId);
    } catch {
      return null;
    }
  }

  async remove(id: string) {
    const row = this.store.require(id);
    const client = this.connectedClient(row.project_id);
    if (client) await client.call('agent.stop', { sessionId: id }).catch((err: Error) => this.log.warn(`agent.stop ${id}: ${err.message}`));
    this.ctx.db.run('DELETE FROM agent_sessions WHERE id = ?', id);
    bus.project(row.project_id, { type: 'session.deleted', projectId: row.project_id, sessionId: id });
    return { ok: true as const };
  }

  rename(id: string, title: string): AgentSession {
    this.store.require(id);
    return toSession(this.store.patch(id, { title })!);
  }
}
