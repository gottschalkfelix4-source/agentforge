import type { Db } from '../db/index.js';
import { type GitHubClient, rateLimit } from './client.js';
import type { RawPull } from './mappers.js';

export interface LinkedRepo {
  projectId: string;
  owner: string;
  name: string;
}

export interface PollerDeps {
  db: Db;
  client: () => GitHubClient | null;
  linked: () => LinkedRepo[];
  publish: (projectId: string) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

interface CursorRow {
  etag: string | null;
  since: string | null;
  last_polled_at: string | null;
}

/** State kept in sync_cursors.since for the pulls resource. */
interface PullsState {
  open: { n: number; sha: string }[];
}

export const POLL_INTERVAL_MS = 60_000;
/** Repos without open PRs are only checked every 5 minutes. */
export const IDLE_INTERVAL_MS = 5 * 60_000;
const MIN_REMAINING = 100;

/**
 * Polls GitHub for linked projects with conditional requests (ETag / If-None-Match — 304s do
 * not count against the rate limit) and publishes `github.changed` when pulls or CI changed.
 * Cursors live in `sync_cursors` (resource `gh:pulls` and `gh:ci:<number>`).
 */
export class GitHubPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = POLL_INTERVAL_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private cursor(projectId: string, resource: string): CursorRow | undefined {
    return this.deps.db.get<CursorRow>(
      'SELECT etag, since, last_polled_at FROM sync_cursors WHERE project_id = ? AND resource = ?',
      projectId,
      resource,
    );
  }

  private save(projectId: string, resource: string, etag: string | null, since: string | null) {
    this.deps.db.run(
      `INSERT INTO sync_cursors (project_id, resource, etag, since, last_polled_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, resource) DO UPDATE SET etag = excluded.etag, since = excluded.since, last_polled_at = excluded.last_polled_at`,
      projectId,
      resource,
      etag,
      since,
      new Date(this.now()).toISOString(),
    );
  }

  private rateLimited(): boolean {
    return rateLimit.remaining !== null && rateLimit.remaining < MIN_REMAINING && (rateLimit.resetAt ?? 0) > this.now();
  }

  /** One polling round over all linked projects. Returns the ids that changed. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    const client = this.deps.client();
    if (!client) return [];
    this.running = true;
    const changed: string[] = [];
    try {
      for (const repo of this.deps.linked()) {
        if (this.rateLimited()) break;
        try {
          if (await this.pollRepo(client, repo)) {
            changed.push(repo.projectId);
            this.deps.publish(repo.projectId);
          }
        } catch (err) {
          this.deps.log?.(`GitHub-Polling ${repo.owner}/${repo.name}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return changed;
  }

  private async pollRepo(client: GitHubClient, repo: LinkedRepo): Promise<boolean> {
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const cur = this.cursor(repo.projectId, 'gh:pulls');
    const state: PullsState = cur?.since ? safeParse(cur.since) : { open: [] };
    const last = cur?.last_polled_at ? Date.parse(cur.last_polled_at) : 0;
    if (cur && state.open.length === 0 && this.now() - last < IDLE_INTERVAL_MS) return false;

    let changed = false;
    const res = await client.request<RawPull[]>('GET', `${base}/pulls`, {
      query: { state: 'open', per_page: 50, sort: 'updated', direction: 'desc' },
      etag: cur?.etag ?? null,
    });
    let open = state.open;
    if (res.status === 304) {
      this.save(repo.projectId, 'gh:pulls', cur?.etag ?? null, cur?.since ?? null);
    } else {
      open = res.data.map((p) => ({ n: p.number, sha: p.head.sha }));
      // The very first poll only records the baseline.
      if (cur && cur.etag !== res.etag) changed = true;
      this.save(repo.projectId, 'gh:pulls', res.etag, JSON.stringify({ open } satisfies PullsState));
    }

    // CI of open PRs: combined status + check runs per head sha, both conditional.
    for (const pr of open) {
      if (this.rateLimited()) break;
      const resource = `gh:ci:${pr.n}`;
      const ci = this.cursor(repo.projectId, resource);
      const sameSha = ci?.since === pr.sha;
      const [statusEtag, checksEtag] = sameSha && ci?.etag ? ci.etag.split('|') : [null, null];
      const sha = encodeURIComponent(pr.sha);
      const s = await client.request('GET', `${base}/commits/${sha}/status`, { etag: statusEtag || null });
      const c = await client.request('GET', `${base}/commits/${sha}/check-runs`, { etag: checksEtag || null, query: { per_page: 100 } });
      const etag = `${s.etag ?? ''}|${c.etag ?? ''}`;
      if (ci && sameSha && (s.status !== 304 || c.status !== 304) && etag !== ci.etag) changed = true;
      this.save(repo.projectId, resource, etag, pr.sha);
    }
    return changed;
  }
}

function safeParse(s: string): PullsState {
  try {
    const v = JSON.parse(s) as PullsState;
    return Array.isArray(v.open) ? v : { open: [] };
  } catch {
    return { open: [] };
  }
}
