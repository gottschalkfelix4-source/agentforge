/**
 * GitHub service (Phase 3). One GitHub account per Agentforge instance.
 *
 * Service API for other features (e.g. the PM agent) — get it with `githubService(ctx)`:
 *   getToken(): string | null                 decrypted token (never send it to the browser)
 *   api(): GitHubClient                       authenticated REST client (throws 400 if not connected)
 *   repoOf(projectId): {owner,name} | null    linked repo of a project
 *   getRepo(owner, name) / listRepos(q, page) / createRepo(input)
 *   listPulls(projectId, state) / getPull(projectId, n) / createPull(projectId, CreatePullRequest)
 *   mergePull(projectId, n, method) / checks(projectId, ref)
 *   listIssues(projectId, { state?, since? }) → GhIssue[] (PRs excluded)
 *   upsertIssue(projectId, { number?, title, body?, state?, labels?, milestone? }) → GhIssue
 *   listMilestones(projectId, state?) / upsertMilestone(projectId, { number?, title, description?, dueOn?, state? })
 * Credentials are pushed into every connected workspace (wsd `git.credentials.set`) and refreshed
 * when the token changes; `github.changed` events are published by the poller.
 */
import type {
  CiState,
  CreatePullRequest,
  GhCheck,
  GhIssue,
  GhPull,
  GhRepo,
  GitHubStatus,
  WsdNotifications,
} from '@vibe/shared';
import type { AppContext } from '../app-context.js';
import { bus } from '../events.js';
import { HttpError } from '../workspaces/manager.js';
import type { WsdClient } from '../workspaces/wsd-client.js';
import { type FetchFn, GitHubClient } from './client.js';
import { DeviceFlow } from './device-flow.js';
import {
  type RawCheckRuns,
  type RawCombinedStatus,
  type RawIssue,
  type RawPull,
  type RawRepo,
  combineCi,
  toChecks,
  toIssue,
  toPull,
  toRepo,
} from './mappers.js';
import { GitHubPoller, type LinkedRepo } from './poller.js';

export interface GitHubSettings {
  secretId: string;
  login: string;
  avatarUrl: string | null;
  scopes: string[];
  name?: string | null;
  userId?: number;
}

export interface GhMilestone {
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  dueOn: string | null;
  htmlUrl: string;
}

export interface UpsertIssueInput {
  number?: number;
  title: string;
  body?: string | null;
  state?: 'open' | 'closed';
  labels?: string[];
  milestone?: number | null;
}

export interface UpsertMilestoneInput {
  number?: number;
  title: string;
  description?: string | null;
  dueOn?: string | null;
  state?: 'open' | 'closed';
}

const GITHUB_HOST = 'github.com';
const SETTINGS_KEY = 'github';
const CLIENT_KEY = 'github_client';

const enc = encodeURIComponent;

export class GitHubService {
  readonly deviceFlow: DeviceFlow;
  private readonly poller: GitHubPoller;
  private readonly cloning = new Set<string>();
  private readonly gitTimers = new Map<string, NodeJS.Timeout>();
  private readonly ciCache = new Map<string, { at: number; checks: GhCheck[] }>();
  private repoCache: { at: number; repos: GhRepo[] } | null = null;
  private started = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.deviceFlow = new DeviceFlow(fetchFn);
    this.poller = new GitHubPoller({
      db: ctx.db,
      client: () => (this.getToken() ? this.api() : null),
      linked: () => this.linkedWithOpenInterest(),
      publish: (projectId) => bus.project(projectId, { type: 'github.changed', projectId }),
      log: (m) => console.warn(m),
    });
  }

  /** Registers workspace hooks and starts the poller (idempotent). */
  start() {
    if (this.started) return;
    this.started = true;
    this.ctx.workspaces.onConnected((projectId, client) => this.onWorkspaceConnected(projectId, client));
    this.ctx.workspaces.onWsdNotification((projectId, method) => this.onNotification(projectId, method));
    this.poller.start();
  }

  // ---- settings / token ------------------------------------------------------

  private readSetting<T>(key: string): T | null {
    const row = this.ctx.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  private writeSetting(key: string, value: unknown | null) {
    if (value === null) this.ctx.db.run('DELETE FROM settings WHERE key = ?', key);
    else {
      this.ctx.db.run(
        'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
        key,
        JSON.stringify(value),
      );
    }
  }

  settings(): GitHubSettings | null {
    return this.readSetting<GitHubSettings>(SETTINGS_KEY);
  }

  clientId(): string | null {
    return this.ctx.cfg.githubClientId || this.readSetting<{ clientId: string }>(CLIENT_KEY)?.clientId || null;
  }

  clientIdInfo(): { clientId: string | null; fromEnv: boolean } {
    return { clientId: this.clientId(), fromEnv: !!this.ctx.cfg.githubClientId };
  }

  setClientId(clientId: string | null) {
    this.writeSetting(CLIENT_KEY, clientId ? { clientId } : null);
  }

  status(): GitHubStatus {
    const s = this.settings();
    const connected = !!s && !!this.getToken();
    return {
      connected,
      login: connected ? s!.login : null,
      avatarUrl: connected ? s!.avatarUrl : null,
      scopes: connected ? s!.scopes : [],
      deviceFlowAvailable: !!this.clientId(),
    };
  }

  getToken(): string | null {
    const s = this.settings();
    if (!s?.secretId) return null;
    try {
      return this.ctx.secrets.get(s.secretId);
    } catch {
      return null;
    }
  }

  api(token?: string): GitHubClient {
    const t = token ?? this.getToken();
    if (!t) throw new HttpError(400, 'github_not_connected', 'GitHub ist nicht verbunden (Einstellungen → GitHub)');
    return new GitHubClient(t, this.fetchFn);
  }

  /** Validates a token via GET /user, stores it encrypted and pushes it to all workspaces. */
  async connectWithToken(token: string, scopesHint: string[] = []): Promise<GitHubSettings> {
    const res = await this.api(token).request<{ login: string; id: number; name: string | null; avatar_url: string | null }>('GET', '/user');
    const headerScopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const prev = this.settings();
    let secretId = prev?.secretId ?? null;
    if (secretId && this.ctx.db.get('SELECT id FROM secrets WHERE id = ?', secretId)) this.ctx.secrets.replace(secretId, token);
    else secretId = this.ctx.secrets.create('github-token', token);
    const settings: GitHubSettings = {
      secretId,
      login: res.data.login,
      avatarUrl: res.data.avatar_url,
      scopes: headerScopes.length ? headerScopes : scopesHint,
      name: res.data.name,
      userId: res.data.id,
    };
    this.writeSetting(SETTINGS_KEY, settings);
    this.repoCache = null;
    await this.pushCredentialsToAll();
    return settings;
  }

  async disconnect() {
    const s = this.settings();
    if (s?.secretId) this.ctx.secrets.delete(s.secretId);
    this.writeSetting(SETTINGS_KEY, null);
    this.repoCache = null;
    await this.pushCredentialsToAll();
  }

  // ---- workspaces --------------------------------------------------------------

  /** Pushes (or clears) the in-memory git credentials + identity into one workspace. */
  async pushCredentials(client: WsdClient) {
    const token = this.getToken();
    const s = this.settings();
    if (!token || !s) {
      await client.call('git.credentials.set', { host: GITHUB_HOST, clear: true });
      return;
    }
    await client.call('git.credentials.set', { host: GITHUB_HOST, username: 'x-access-token', token });
    const email = s.userId ? `${s.userId}+${s.login}@users.noreply.github.com` : `${s.login}@users.noreply.github.com`;
    await client.call('git.identity.set', { name: s.name || s.login, email });
  }

  async pushCredentialsToAll() {
    await Promise.all(
      this.ctx.workspaces.connectedProjects().map(async (projectId) => {
        try {
          await this.pushCredentials(this.ctx.workspaces.client(projectId));
        } catch (err) {
          console.warn(`GitHub-Credentials für ${projectId}: ${(err as Error).message}`);
        }
      }),
    );
  }

  private async onWorkspaceConnected(projectId: string, client: WsdClient) {
    await this.pushCredentials(client);
    await this.cloneIfEmpty(projectId, client);
  }

  /** Linked projects are cloned via RPC after the credentials were pushed (works for private repos). */
  private async cloneIfEmpty(projectId: string, client: WsdClient) {
    const repo = this.repoOf(projectId);
    if (!repo || this.cloning.has(projectId)) return;
    const entries = (await client.call('fs.list', { path: '.' })).filter((e) => e.name !== 'lost+found');
    if (entries.length) return;
    this.cloning.add(projectId);
    try {
      await client.call('git.clone', { url: `https://github.com/${repo.owner}/${repo.name}.git` });
      bus.project(projectId, { type: 'git.changed', projectId });
    } catch (err) {
      // Long clones outlive the 30 s RPC timeout but keep running in wsd; fs.changed → git.changed follows.
      console.warn(`git clone ${repo.owner}/${repo.name}: ${(err as Error).message}`);
    } finally {
      this.cloning.delete(projectId);
    }
  }

  private onNotification(projectId: string, method: keyof WsdNotifications) {
    if (method !== 'fs.changed') return;
    if (this.gitTimers.has(projectId)) return;
    this.gitTimers.set(
      projectId,
      setTimeout(() => {
        this.gitTimers.delete(projectId);
        bus.project(projectId, { type: 'git.changed', projectId });
      }, 1000),
    );
  }

  // ---- repos ---------------------------------------------------------------------

  repoOf(projectId: string): { owner: string; name: string } | null {
    const r = this.ctx.db.get<{ repo_owner: string | null; repo_name: string | null }>(
      'SELECT repo_owner, repo_name FROM projects WHERE id = ?',
      projectId,
    );
    return r?.repo_owner && r.repo_name ? { owner: r.repo_owner, name: r.repo_name } : null;
  }

  requireRepo(projectId: string): { owner: string; name: string; base: string } {
    const r = this.repoOf(projectId);
    if (!r) throw new HttpError(400, 'no_repo', 'Projekt ist nicht mit einem GitHub-Repository verknüpft');
    return { ...r, base: `/repos/${enc(r.owner)}/${enc(r.name)}` };
  }

  private linkedWithOpenInterest(): LinkedRepo[] {
    return this.ctx.db
      .all<{ id: string; repo_owner: string; repo_name: string }>(
        'SELECT id, repo_owner, repo_name FROM projects WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL AND archived = 0',
      )
      .map((r) => ({ projectId: r.id, owner: r.repo_owner, name: r.repo_name }));
  }

  async getRepo(owner: string, name: string): Promise<GhRepo> {
    return toRepo(await this.api().get<RawRepo>(`/repos/${enc(owner)}/${enc(name)}`));
  }

  async listRepos(q: string | undefined, page = 1): Promise<GhRepo[]> {
    const api = this.api();
    const query = q?.trim().toLowerCase();
    if (!query) {
      const raw = await api.get<RawRepo[]>('/user/repos', {
        sort: 'pushed',
        per_page: 50,
        page,
        affiliation: 'owner,collaborator,organization_member',
      });
      return raw.map(toRepo);
    }
    // Filter the user's accessible repos (cached briefly); add an exact owner/name hit if given.
    if (!this.repoCache || Date.now() - this.repoCache.at > 60_000) {
      const all: GhRepo[] = [];
      for (let p = 1; p <= 5; p++) {
        const raw = await api.get<RawRepo[]>('/user/repos', { sort: 'pushed', per_page: 100, page: p, affiliation: 'owner,collaborator,organization_member' });
        all.push(...raw.map(toRepo));
        if (raw.length < 100) break;
      }
      this.repoCache = { at: Date.now(), repos: all };
    }
    const hits = this.repoCache.repos.filter((r) => r.fullName.toLowerCase().includes(query) || (r.description ?? '').toLowerCase().includes(query));
    const exact = /^([\w.-]+)\/([\w.-]+)$/.exec(q!.trim());
    if (exact && !hits.some((r) => r.fullName.toLowerCase() === query)) {
      try {
        hits.unshift(await this.getRepo(exact[1]!, exact[2]!));
      } catch {
        /* not accessible */
      }
    }
    return hits.slice((page - 1) * 50, page * 50);
  }

  /** Organisations the user belongs to (candidates for "owner" when creating a repo). */
  async listOrgs(): Promise<{ login: string; avatarUrl: string | null }[]> {
    const raw = await this.api().get<{ login: string; avatar_url?: string }[]>('/user/orgs', { per_page: 100 });
    return raw.map((o) => ({ login: o.login, avatarUrl: o.avatar_url ?? null }));
  }

  /**
   * Creates a repository for the user or an org. `autoInit` adds an initial commit (README) so the repo can be
   * cloned with a default branch right away — used when a new project starts from a fresh repo.
   */
  async createRepo(input: {
    name: string;
    private?: boolean;
    description?: string | null;
    org?: string | null;
    autoInit?: boolean;
  }): Promise<GhRepo> {
    const body = {
      name: input.name,
      private: input.private ?? true,
      description: input.description ?? undefined,
      auto_init: input.autoInit ?? false,
    };
    const path = input.org ? `/orgs/${enc(input.org)}/repos` : '/user/repos';
    this.repoCache = null;
    try {
      return toRepo(await this.api().post<RawRepo>(path, body));
    } catch (err) {
      if (err instanceof HttpError && err.code === 'github_invalid' && /already exists/i.test(err.message)) {
        throw new HttpError(409, 'github_repo_exists', `Ein Repository „${input.name}“ existiert dort bereits`);
      }
      throw err;
    }
  }

  // ---- pulls / checks --------------------------------------------------------------

  async checksFor(owner: string, name: string, ref: string, fresh = false): Promise<GhCheck[]> {
    const key = `${owner}/${name}@${ref}`;
    const hit = this.ciCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.checks;
    const api = this.api();
    const base = `/repos/${enc(owner)}/${enc(name)}/commits/${enc(ref)}`;
    const [status, runs] = await Promise.all([
      api.get<RawCombinedStatus>(`${base}/status`).catch(() => null),
      api.get<RawCheckRuns>(`${base}/check-runs`, { per_page: 100 }).catch(() => null),
    ]);
    const checks = toChecks(status, runs);
    this.ciCache.set(key, { at: Date.now(), checks });
    if (this.ciCache.size > 500) this.ciCache.delete(this.ciCache.keys().next().value!);
    return checks;
  }

  async checks(projectId: string, ref?: string): Promise<GhCheck[]> {
    const r = this.requireRepo(projectId);
    const target = ref || (await this.getRepo(r.owner, r.name)).defaultBranch;
    return this.checksFor(r.owner, r.name, target, true);
  }

  private async ciOf(owner: string, name: string, sha: string): Promise<CiState> {
    return combineCi(await this.checksFor(owner, name, sha));
  }

  async listPulls(projectId: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GhPull[]> {
    const r = this.requireRepo(projectId);
    const raw = await this.api().get<RawPull[]>(`${r.base}/pulls`, { state, per_page: 50, sort: 'updated', direction: 'desc' });
    return Promise.all(
      raw.map(async (p, i) => toPull(p, p.state === 'open' && i < 20 ? await this.ciOf(r.owner, r.name, p.head.sha).catch(() => 'none' as CiState) : 'none')),
    );
  }

  async getPull(projectId: string, n: number): Promise<GhPull & { checks: GhCheck[] }> {
    const r = this.requireRepo(projectId);
    const raw = await this.api().get<RawPull>(`${r.base}/pulls/${n}`);
    const checks = await this.checksFor(r.owner, r.name, raw.head.sha, true);
    return { ...toPull(raw, combineCi(checks)), checks };
  }

  async createPull(projectId: string, input: CreatePullRequest): Promise<GhPull> {
    const r = this.requireRepo(projectId);
    const base = input.base || (await this.getRepo(r.owner, r.name)).defaultBranch;
    const raw = await this.api().post<RawPull>(`${r.base}/pulls`, {
      title: input.title,
      body: input.body ?? '',
      head: input.head,
      base,
      draft: input.draft ?? false,
    });
    bus.project(projectId, { type: 'github.changed', projectId });
    return toPull(raw);
  }

  async mergePull(projectId: string, n: number, method: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const r = this.requireRepo(projectId);
    const res = await this.api().put<{ merged: boolean; sha: string | null; message: string }>(`${r.base}/pulls/${n}/merge`, { merge_method: method });
    bus.project(projectId, { type: 'github.changed', projectId });
    return res;
  }

  // ---- issues / milestones -------------------------------------------------------------

  async listIssues(projectId: string, opts: { state?: 'open' | 'closed' | 'all'; since?: string | null } = {}): Promise<GhIssue[]> {
    const r = this.requireRepo(projectId);
    const out: GhIssue[] = [];
    for (let page = 1; page <= 10; page++) {
      const raw = await this.api().get<RawIssue[]>(`${r.base}/issues`, {
        state: opts.state ?? 'open',
        since: opts.since ?? undefined,
        per_page: 100,
        page,
        sort: 'updated',
        direction: 'desc',
      });
      out.push(...raw.filter((i) => !i.pull_request).map(toIssue));
      if (raw.length < 100) break;
    }
    return out;
  }

  async upsertIssue(projectId: string, input: UpsertIssueInput): Promise<GhIssue> {
    const r = this.requireRepo(projectId);
    const body: Record<string, unknown> = { title: input.title };
    if (input.body !== undefined) body.body = input.body ?? '';
    if (input.labels !== undefined) body.labels = input.labels;
    if (input.milestone !== undefined) body.milestone = input.milestone;
    if (input.state !== undefined && input.number) body.state = input.state;
    const raw = input.number
      ? await this.api().patch<RawIssue>(`${r.base}/issues/${input.number}`, body)
      : await this.api().post<RawIssue>(`${r.base}/issues`, body);
    bus.project(projectId, { type: 'github.changed', projectId });
    return toIssue(raw);
  }

  async listMilestones(projectId: string, state: 'open' | 'closed' | 'all' = 'all'): Promise<GhMilestone[]> {
    const r = this.requireRepo(projectId);
    const raw = await this.api().get<{ number: number; title: string; description: string | null; state: 'open' | 'closed'; due_on: string | null; html_url: string }[]>(
      `${r.base}/milestones`,
      { state, per_page: 100 },
    );
    return raw.map((m) => ({ number: m.number, title: m.title, description: m.description, state: m.state, dueOn: m.due_on, htmlUrl: m.html_url }));
  }

  async upsertMilestone(projectId: string, input: UpsertMilestoneInput): Promise<GhMilestone> {
    const r = this.requireRepo(projectId);
    const body: Record<string, unknown> = { title: input.title };
    if (input.description !== undefined) body.description = input.description ?? '';
    if (input.dueOn !== undefined) body.due_on = input.dueOn;
    if (input.state !== undefined) body.state = input.state;
    const m = input.number
      ? await this.api().patch<{ number: number; title: string; description: string | null; state: 'open' | 'closed'; due_on: string | null; html_url: string }>(
          `${r.base}/milestones/${input.number}`,
          body,
        )
      : await this.api().post<{ number: number; title: string; description: string | null; state: 'open' | 'closed'; due_on: string | null; html_url: string }>(
          `${r.base}/milestones`,
          body,
        );
    return { number: m.number, title: m.title, description: m.description, state: m.state, dueOn: m.due_on, htmlUrl: m.html_url };
  }
}

const instances = new WeakMap<AppContext, GitHubService>();

/** The GitHub service of this app instance (created lazily, shared by all features). */
export function githubService(ctx: AppContext): GitHubService {
  let s = instances.get(ctx);
  if (!s) {
    s = new GitHubService(ctx);
    instances.set(ctx, s);
  }
  return s;
}
