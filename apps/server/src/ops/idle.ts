import type { AgentSessionState, TerminalInfo } from '@vibe/shared';
import type { Db } from '../db/index.js';
import type { WorkspaceManager } from '../workspaces/manager.js';

/**
 * Idle auto-stop for workspaces.
 *
 * A workspace counts as idle when it has no running agent session and no terminal whose process
 * is still alive. It is stopped after it has been idle in *every* sample for N consecutive
 * minutes. Anything we cannot observe (daemon not connected, RPC error) resets the timer,
 * so an uncertain workspace is never stopped.
 */

export const IDLE_SETTING_KEY = 'workspaceIdleMinutes';
export const IDLE_CHECK_INTERVAL_MS = 60_000;

/** One observation of a running workspace. `busy: null` = could not be determined. */
export interface IdleSample {
  projectId: string;
  busy: boolean | null;
}

export interface IdleDecision {
  /** projectId → epoch ms since which it has been continuously idle. */
  idleSince: Map<string, number>;
  /** Workspaces that reached the idle limit and should be stopped now. */
  stop: string[];
}

export function isBusy(terminals: Pick<TerminalInfo, 'exited'>[], agents: Pick<AgentSessionState, 'running'>[]): boolean {
  return terminals.some((t) => !t.exited) || agents.some((a) => a.running);
}

/**
 * Pure state transition: previous idle-since map + current samples → next map + workspaces to stop.
 * Workspaces missing from `samples` (not running any more) are forgotten.
 */
export function evaluateIdle(prev: ReadonlyMap<string, number>, samples: IdleSample[], now: number, idleMs: number): IdleDecision {
  const idleSince = new Map<string, number>();
  const stop: string[] = [];
  if (idleMs <= 0) return { idleSince, stop };
  for (const s of samples) {
    if (s.busy !== false) continue; // busy or unknown → timer reset
    const since = prev.get(s.projectId) ?? now;
    if (now - since >= idleMs) stop.push(s.projectId);
    else idleSince.set(s.projectId, since);
  }
  return { idleSince, stop };
}

export function envIdleMinutes(): number {
  const n = Number(process.env.WORKSPACE_IDLE_MINUTES ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Stored setting (null = not set, fall back to the environment). */
export function storedIdleMinutes(db: Db): number | null {
  const row = db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', IDLE_SETTING_KEY);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value_json) as unknown;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  } catch {
    return null;
  }
}

export function setStoredIdleMinutes(db: Db, minutes: number | null) {
  if (minutes === null) db.run('DELETE FROM settings WHERE key = ?', IDLE_SETTING_KEY);
  else {
    db.run(
      'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      IDLE_SETTING_KEY,
      JSON.stringify(minutes),
    );
  }
}

export function effectiveIdleMinutes(db: Db): number {
  return storedIdleMinutes(db) ?? envIdleMinutes();
}

export interface IdleStopperDeps {
  db: Db;
  workspaces: Pick<WorkspaceManager, 'connectedProjects' | 'get' | 'client' | 'stop'>;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

/** Periodically samples running workspaces and stops idle ones. */
export class IdleStopper {
  private idleSince = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly lastError = new Map<string, string>();

  constructor(private readonly deps: IdleStopperDeps) {}

  start(intervalMs = IDLE_CHECK_INTERVAL_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Current idle-since timestamps (for diagnostics). */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.idleSince].map(([k, v]) => [k, new Date(v).toISOString()]));
  }

  private async sample(projectId: string): Promise<IdleSample> {
    try {
      if (this.deps.workspaces.get(projectId)?.status !== 'running') return { projectId, busy: null };
      const client = this.deps.workspaces.client(projectId);
      const [terminals, agents] = await Promise.all([
        client.call('term.list', {}),
        // Older workspace images have no structured agent sessions (agents then only run in terminals).
        client.call('agent.list', {}).catch((err: Error) => {
          if (/method not found/i.test(err.message)) return [];
          throw err;
        }),
      ]);
      this.lastError.delete(projectId);
      return { projectId, busy: isBusy(terminals, agents) };
    } catch (err) {
      // Unknown state → never stop. Log once per distinct error so a broken daemon is visible.
      const msg = (err as Error).message;
      if (this.lastError.get(projectId) !== msg) {
        this.lastError.set(projectId, msg);
        this.deps.log.warn(`Idle-Prüfung ${projectId} nicht möglich: ${msg}`);
      }
      return { projectId, busy: null };
    }
  }

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      const minutes = effectiveIdleMinutes(this.deps.db);
      if (minutes <= 0) {
        this.idleSince.clear();
        return;
      }
      const samples = await Promise.all(this.deps.workspaces.connectedProjects().map((id) => this.sample(id)));
      const { idleSince, stop } = evaluateIdle(this.idleSince, samples, now, minutes * 60_000);
      this.idleSince = idleSince;
      for (const projectId of stop) {
        this.deps.log.info(`Workspace ${projectId} ist seit ${minutes} min inaktiv – wird gestoppt.`);
        await this.deps.workspaces.stop(projectId).catch((err: Error) => this.deps.log.warn(`Idle-Stop ${projectId}: ${err.message}`));
      }
    } finally {
      this.running = false;
    }
  }
}
