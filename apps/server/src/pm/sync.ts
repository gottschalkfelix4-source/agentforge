/**
 * Bidirectional GitHub Issues/Milestones ↔ tasks/milestones sync (linked projects only).
 *
 * Change detection per entity: after every successful pull/push the local `updated_at` and
 * `gh_updated_at` are both set to GitHub's `updated_at`. Hence
 *   remote changed  ⇔ issue.updated_at > gh_updated_at
 *   local changed   ⇔ updated_at       > gh_updated_at   (every local mutation bumps updated_at)
 * Both changed → last writer wins (newer timestamp), logged as conflict in `sync_log`.
 * Cursors (`sync_cursors`): `pm:milestones` (ETag), `pm:issues` (ETag + `since`).
 */
import type { GhIssue, PmSettings, PmSyncResult, TaskColumn } from '@vibe/shared';
import { TASK_COLUMNS } from '@vibe/shared';
import type { Db } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { type GitHubClient, rateLimit } from '../github/client.js';
import { type RawIssue, toIssue } from '../github/mappers.js';
import { HttpError } from '../workspaces/manager.js';
import { type MilestoneRow, type PmRepo, publishPm, type TaskRow } from './repo.js';

// ---- pure mapping -------------------------------------------------------------------------

export const STATUS_PREFIX = 'status:';

export type SyncDecision = 'none' | 'pull' | 'push' | 'conflict_pull' | 'conflict_push';

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** What to do with an entity that exists on both sides. */
export function decide(local: { updatedAt: string; ghUpdatedAt: string | null }, remoteUpdatedAt: string): SyncDecision {
  const base = ms(local.ghUpdatedAt);
  const remote = ms(remoteUpdatedAt);
  const loc = ms(local.updatedAt);
  const remoteChanged = Number.isNaN(base) || remote > base;
  const localChanged = Number.isNaN(base) || loc > base;
  if (remoteChanged && localChanged) return remote > loc ? 'conflict_pull' : 'conflict_push';
  if (remoteChanged) return 'pull';
  if (localChanged) return 'push';
  return 'none';
}

/** Local entity changed since the last sync? */
export function locallyChanged(updatedAt: string, ghUpdatedAt: string | null): boolean {
  const base = ms(ghUpdatedAt);
  return Number.isNaN(base) || ms(updatedAt) > base;
}

export const isStatusLabel = (name: string) => name.toLowerCase().startsWith(STATUS_PREFIX);

/** Kanban column of an issue: closed → done, `status:<col>` label → col, otherwise keep (reopened → todo). */
export function columnFromIssue(issue: Pick<GhIssue, 'state' | 'labels'>, current: TaskColumn | null): TaskColumn {
  if (issue.state === 'closed') return 'done';
  const status = issue.labels
    .map((l) => l.name.toLowerCase())
    .filter(isStatusLabel)
    .map((n) => n.slice(STATUS_PREFIX.length) as TaskColumn)
    .find((c) => TASK_COLUMNS.includes(c) && c !== 'done');
  if (status) return status;
  if (!current) return 'backlog';
  return current === 'done' ? 'todo' : current;
}

export interface IssueFields {
  title: string;
  body: string;
  column: TaskColumn;
  labels: { name: string; color: string }[];
  milestoneNumber: number | null;
}

export function taskFieldsFromIssue(issue: GhIssue, current: TaskColumn | null): IssueFields {
  return {
    title: issue.title,
    body: issue.body ?? '',
    column: columnFromIssue(issue, current),
    labels: issue.labels.filter((l) => l.name && !isStatusLabel(l.name)),
    milestoneNumber: issue.milestone?.number ?? null,
  };
}

export interface IssuePayload {
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  milestone: number | null;
}

export function issuePayloadFromTask(task: { title: string; body: string; column: TaskColumn }, labelNames: string[], milestoneNumber: number | null): IssuePayload {
  return {
    title: task.title,
    body: task.body,
    state: task.column === 'done' ? 'closed' : 'open',
    labels: [...labelNames.filter((n) => !isStatusLabel(n)), `${STATUS_PREFIX}${task.column}`],
    milestone: milestoneNumber,
  };
}

export interface RawMilestone {
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  due_on: string | null;
  updated_at: string;
  html_url: string;
}

/** GitHub due_on (datetime) → local date `YYYY-MM-DD`. */
export const dueFromGh = (d: string | null) => (d ? d.slice(0, 10) : null);
/** Local date → GitHub due_on (noon UTC so every timezone shows the same day). */
export const dueToGh = (d: string | null) => (d ? `${d.slice(0, 10)}T12:00:00Z` : null);

// ---- engine -------------------------------------------------------------------------------

export interface SyncGitHub {
  repoOf(projectId: string): { owner: string; name: string } | null;
  /** Authenticated client or null when GitHub is not connected. */
  client(): GitHubClient | null;
}

export const DEFAULT_SETTINGS: PmSettings = { syncEnabled: true, syncCreateIssues: true };
export const SYNC_INTERVAL_MS = 2 * 60_000;

const settingsKey = (projectId: string) => `pm:${projectId}`;
const lastSyncKey = (projectId: string) => `pm-sync:${projectId}`;

interface Counter {
  pulled: number;
  pushed: number;
  conflicts: number;
}

export class PmSync {
  private readonly running = new Map<string, Promise<PmSyncResult>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly repo: PmRepo,
    private readonly gh: SyncGitHub,
    private readonly log: (m: string) => void = () => {},
  ) {}

  settings(projectId: string): PmSettings {
    const s = this.repo.readSetting<Partial<PmSettings>>(settingsKey(projectId)) ?? {};
    return {
      syncEnabled: s.syncEnabled ?? DEFAULT_SETTINGS.syncEnabled,
      syncCreateIssues: s.syncCreateIssues ?? DEFAULT_SETTINGS.syncCreateIssues,
      linked: !!this.gh.repoOf(projectId),
      lastSync: this.repo.readSetting<PmSyncResult>(lastSyncKey(projectId)),
    };
  }

  setSettings(projectId: string, s: { syncEnabled?: boolean; syncCreateIssues?: boolean }): PmSettings {
    const cur = this.settings(projectId);
    this.repo.writeSetting(settingsKey(projectId), {
      syncEnabled: s.syncEnabled ?? cur.syncEnabled,
      syncCreateIssues: s.syncCreateIssues ?? cur.syncCreateIssues,
    });
    return this.settings(projectId);
  }

  start(intervalMs = SYNC_INTERVAL_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.gh.client()) return;
    const projects = this.db.all<{ id: string }>(
      'SELECT id FROM projects WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL AND archived = 0',
    );
    for (const p of projects) {
      if (rateLimit.remaining !== null && rateLimit.remaining < 200 && (rateLimit.resetAt ?? 0) > Date.now()) break;
      if (!this.settings(p.id).syncEnabled) continue;
      await this.sync(p.id).catch(() => {});
    }
  }

  /** Runs one sync of a project (concurrent calls share the running sync). */
  sync(projectId: string): Promise<PmSyncResult> {
    const cur = this.running.get(projectId);
    if (cur) return cur;
    const p = this.run(projectId).finally(() => this.running.delete(projectId));
    this.running.set(projectId, p);
    return p;
  }

  private async run(projectId: string): Promise<PmSyncResult> {
    const linked = this.gh.repoOf(projectId);
    if (!linked) throw new HttpError(400, 'no_repo', 'Projekt ist nicht mit einem GitHub-Repository verknüpft');
    const client = this.gh.client();
    if (!client) throw new HttpError(400, 'github_not_connected', 'GitHub ist nicht verbunden (Einstellungen → GitHub)');
    const base = `/repos/${encodeURIComponent(linked.owner)}/${encodeURIComponent(linked.name)}`;
    const settings = this.settings(projectId);
    const c: Counter = { pulled: 0, pushed: 0, conflicts: 0 };
    let result: PmSyncResult;
    try {
      await this.syncMilestones(projectId, client, base, settings, c);
      await this.syncIssues(projectId, client, base, settings, c);
      result = { at: nowIso(), ok: true, message: null, ...c };
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`PM-Sync ${linked.owner}/${linked.name}: ${msg}`);
      result = { at: nowIso(), ok: false, message: msg, ...c };
    }
    this.repo.writeSetting(lastSyncKey(projectId), result);
    if (c.pulled || c.pushed) {
      publishPm(projectId, 'milestone');
      publishPm(projectId, 'task');
    } else publishPm(projectId, 'task');
    if (!result.ok) throw new HttpError(502, 'sync_failed', `GitHub-Sync fehlgeschlagen: ${result.message}`);
    return result;
  }

  // ---- cursors ----------------------------------------------------------------------------

  private cursor(projectId: string, resource: string) {
    return this.db.get<{ etag: string | null; since: string | null }>(
      'SELECT etag, since FROM sync_cursors WHERE project_id = ? AND resource = ?',
      projectId,
      resource,
    );
  }

  private saveCursor(projectId: string, resource: string, etag: string | null, since: string | null) {
    this.db.run(
      `INSERT INTO sync_cursors (project_id, resource, etag, since, last_polled_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, resource) DO UPDATE SET etag = excluded.etag, since = excluded.since, last_polled_at = excluded.last_polled_at`,
      projectId,
      resource,
      etag,
      since,
      nowIso(),
    );
  }

  // ---- milestones ----------------------------------------------------------------------------

  private markMilestoneSynced(id: string, m: RawMilestone, extra: Partial<MilestoneRow> = {}) {
    this.db.update('milestones', id, { ...extra, gh_number: m.number, gh_updated_at: m.updated_at, updated_at: m.updated_at });
  }

  private async syncMilestones(projectId: string, client: GitHubClient, base: string, settings: PmSettings, c: Counter) {
    const cur = this.cursor(projectId, 'pm:milestones');
    const res = await client.request<RawMilestone[]>('GET', `${base}/milestones`, {
      query: { state: 'all', per_page: 100, sort: 'due_on' },
      etag: cur?.etag ?? null,
    });
    const handled = new Set<string>();
    if (res.status !== 304) {
      for (const m of res.data) {
        const local = this.db.get<MilestoneRow>('SELECT * FROM milestones WHERE project_id = ? AND gh_number = ?', projectId, m.number);
        const fields = { title: m.title, description: m.description ?? '', due_on: dueFromGh(m.due_on), state: m.state };
        if (!local) {
          // Adopt a local milestone with the same title that was never pushed, otherwise create one.
          const byTitle = this.db.get<MilestoneRow>(
            'SELECT * FROM milestones WHERE project_id = ? AND gh_number IS NULL AND title = ?',
            projectId,
            m.title,
          );
          const id = byTitle?.id ?? this.repo.createMilestone(projectId, { title: m.title }).id;
          this.markMilestoneSynced(id, m, fields);
          handled.add(id);
          this.repo.log(projectId, 'pull', 'milestone', id, `Meilenstein „${m.title}“ von GitHub übernommen`);
          c.pulled++;
          continue;
        }
        handled.add(local.id);
        const d = decide({ updatedAt: local.updated_at, ghUpdatedAt: local.gh_updated_at }, m.updated_at);
        if (d === 'pull' || d === 'conflict_pull') {
          this.markMilestoneSynced(local.id, m, fields);
          this.repo.log(projectId, 'pull', 'milestone', local.id, `${d === 'conflict_pull' ? 'Konflikt – GitHub gewinnt: ' : ''}Meilenstein „${m.title}“ aktualisiert`);
          c.pulled++;
          if (d === 'conflict_pull') c.conflicts++;
        } else if (d === 'conflict_push') {
          handled.delete(local.id); // pushed below
          c.conflicts++;
          this.repo.log(projectId, 'push', 'milestone', local.id, `Konflikt – lokale Änderung gewinnt: Meilenstein „${local.title}“`);
        } else if (d === 'push') {
          handled.delete(local.id);
        }
      }
      this.saveCursor(projectId, 'pm:milestones', res.etag, null);
    }

    for (const m of this.repo.milestoneRows(projectId)) {
      if (handled.has(m.id)) continue;
      if (m.gh_number && !locallyChanged(m.updated_at, m.gh_updated_at)) continue;
      if (!m.gh_number && !settings.syncCreateIssues) continue;
      const body = { title: m.title, description: m.description, due_on: dueToGh(m.due_on), state: m.state };
      const path = m.gh_number ? `${base}/milestones/${m.gh_number}` : `${base}/milestones`;
      const res2 = await client.request<RawMilestone>(m.gh_number ? 'PATCH' : 'POST', path, { body });
      this.markMilestoneSynced(m.id, res2.data);
      this.repo.log(projectId, 'push', 'milestone', m.id, `Meilenstein „${m.title}“ ${m.gh_number ? 'aktualisiert' : `als #${res2.data.number} angelegt`}`);
      c.pushed++;
    }
    // Our own writes changed the list; drop the ETag so the next round re-reads it once.
    if (c.pushed) this.saveCursor(projectId, 'pm:milestones', null, null);
  }

  // ---- issues ------------------------------------------------------------------------------------

  private async fetchIssues(projectId: string, client: GitHubClient, base: string): Promise<GhIssue[] | null> {
    const cur = this.cursor(projectId, 'pm:issues');
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const out: GhIssue[] = [];
    let etag: string | null = null;
    for (let page = 1; page <= 20; page++) {
      const res = await client.request<RawIssue[]>('GET', `${base}/issues`, {
        query: { state: 'all', since: cur?.since ?? undefined, per_page: 100, page, sort: 'updated', direction: 'asc' },
        etag: page === 1 ? (cur?.etag ?? null) : null,
      });
      if (res.status === 304) {
        this.saveCursor(projectId, 'pm:issues', cur?.etag ?? null, cur?.since ?? null);
        return null;
      }
      if (page === 1) etag = res.etag;
      out.push(...res.data.filter((i) => !i.pull_request).map(toIssue));
      if (res.data.length < 100) break;
    }
    this.saveCursor(projectId, 'pm:issues', etag, startedAt);
    return out;
  }

  private milestoneIdForNumber(projectId: string, n: number | null): string | null {
    if (!n) return null;
    return this.db.get<{ id: string }>('SELECT id FROM milestones WHERE project_id = ? AND gh_number = ?', projectId, n)?.id ?? null;
  }

  private applyIssue(projectId: string, issue: GhIssue, local: TaskRow | undefined): string {
    const f = taskFieldsFromIssue(issue, local?.col ?? null);
    const labelIds = f.labels.map((l) => this.repo.ensureLabel(projectId, l.name, l.color).id);
    const input = { title: f.title, body: f.body, column: f.column, milestoneId: this.milestoneIdForNumber(projectId, f.milestoneNumber), labelIds };
    const extra: Partial<TaskRow> = {
      gh_issue_number: issue.number,
      gh_url: issue.htmlUrl,
      gh_updated_at: issue.updatedAt,
      updated_at: issue.updatedAt,
      sync_state: 'synced',
    };
    return local ? this.repo.updateTask(local.id, input, extra).id : this.repo.createTask(projectId, input, extra).id;
  }

  private async syncIssues(projectId: string, client: GitHubClient, base: string, settings: PmSettings, c: Counter) {
    const issues = await this.fetchIssues(projectId, client, base);
    const handled = new Set<string>();
    for (const issue of issues ?? []) {
      const local = this.db.get<TaskRow>('SELECT * FROM tasks WHERE project_id = ? AND gh_issue_number = ?', projectId, issue.number);
      if (!local) {
        const id = this.applyIssue(projectId, issue, undefined);
        handled.add(id);
        this.repo.log(projectId, 'pull', 'task', id, `Issue #${issue.number} „${issue.title}“ als Aufgabe übernommen`);
        c.pulled++;
        continue;
      }
      const d = decide({ updatedAt: local.updated_at, ghUpdatedAt: local.gh_updated_at }, issue.updatedAt);
      if (d === 'pull' || d === 'conflict_pull') {
        this.applyIssue(projectId, issue, local);
        handled.add(local.id);
        this.repo.log(projectId, 'pull', 'task', local.id, `${d === 'conflict_pull' ? 'Konflikt – GitHub gewinnt: ' : ''}Issue #${issue.number} → Aufgabe aktualisiert`);
        c.pulled++;
        if (d === 'conflict_pull') c.conflicts++;
      } else if (d === 'conflict_push') {
        c.conflicts++;
        this.repo.log(projectId, 'push', 'task', local.id, `Konflikt – lokale Änderung gewinnt: Aufgabe „${local.title}“ (#${issue.number})`);
      } else if (d === 'none') {
        handled.add(local.id);
      }
    }

    let pushed = 0;
    for (const t of this.repo.taskRows(projectId)) {
      if (handled.has(t.id)) continue;
      if (t.gh_issue_number && !locallyChanged(t.updated_at, t.gh_updated_at)) continue;
      if (!t.gh_issue_number && !settings.syncCreateIssues) continue;
      const labels = this.repo.taskLabelRows(t.id).map((l) => l.name);
      const msNumber = t.milestone_id ? (this.repo.milestoneRow(t.milestone_id).gh_number ?? null) : null;
      const payload = issuePayloadFromTask({ title: t.title, body: t.body, column: t.col }, labels, msNumber);
      const res = t.gh_issue_number
        ? await client.request<RawIssue>('PATCH', `${base}/issues/${t.gh_issue_number}`, { body: payload })
        : await client.request<RawIssue>('POST', `${base}/issues`, { body: { ...payload, state: undefined } });
      let issue = toIssue(res.data);
      if (!t.gh_issue_number && payload.state === 'closed') {
        issue = toIssue((await client.request<RawIssue>('PATCH', `${base}/issues/${issue.number}`, { body: { state: 'closed' } })).data);
      }
      this.db.update('tasks', t.id, {
        gh_issue_number: issue.number,
        gh_url: issue.htmlUrl,
        gh_updated_at: issue.updatedAt,
        updated_at: issue.updatedAt,
        sync_state: 'synced',
      });
      this.repo.log(projectId, 'push', 'task', t.id, t.gh_issue_number ? `Aufgabe „${t.title}“ → Issue #${issue.number} aktualisiert` : `Aufgabe „${t.title}“ als Issue #${issue.number} angelegt`);
      pushed++;
    }
    c.pushed += pushed;
  }
}
