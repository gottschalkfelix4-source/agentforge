import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { Workspace, WorkspaceStatus, WsdNotifications } from '@vibe/shared';
import { ulid } from 'ulid';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { bus } from '../events.js';
import type { Orchestrator } from '../docker/orchestrator.js';
import { WsdClient } from './wsd-client.js';

interface WorkspaceRow {
  id: string;
  project_id: string;
  container_id: string | null;
  image: string;
  status: WorkspaceStatus;
  status_message: string | null;
  cpu_limit: number | null;
  mem_limit_mb: number | null;
  last_seen_at: string | null;
}

export function workspaceDto(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    projectId: r.project_id,
    containerId: r.container_id,
    image: r.image,
    status: r.status,
    statusMessage: r.status_message,
    cpuLimit: r.cpu_limit,
    memLimitMb: r.mem_limit_mb,
    lastSeenAt: r.last_seen_at,
  };
}

export type NotificationListener = (projectId: string, method: keyof WsdNotifications, params: unknown) => void;
export type ConnectedListener = (projectId: string, client: WsdClient) => void | Promise<void>;

export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Lifecycle of workspace containers and the daemon connections to them. */
export class WorkspaceManager {
  private readonly clients = new Map<string, WsdClient>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly orch: Orchestrator,
    private readonly cfg: Config,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  row(projectId: string): WorkspaceRow | undefined {
    return this.db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE project_id = ?', projectId);
  }

  get(projectId: string): Workspace | null {
    const r = this.row(projectId);
    return r ? workspaceDto(r) : null;
  }

  createRecord(projectId: string) {
    this.db.insert('workspaces', {
      id: ulid(),
      project_id: projectId,
      container_id: null,
      image: this.cfg.workspaceImage,
      status: 'none',
      status_message: null,
      cpu_limit: this.cfg.defaultCpuLimit,
      mem_limit_mb: this.cfg.defaultMemLimitMb,
      last_seen_at: null,
    });
  }

  private setStatus(projectId: string, status: WorkspaceStatus, message: string | null = null) {
    this.db.run('UPDATE workspaces SET status = ?, status_message = ? WHERE project_id = ?', status, message, projectId);
    const e = { type: 'workspace.status' as const, projectId, status, message };
    bus.project(projectId, e);
    bus.publish('projects', e);
  }

  /** Serializes lifecycle operations per project. */
  private withLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(projectId, next);
    void next.finally(() => {
      if (this.locks.get(projectId) === next) this.locks.delete(projectId);
    }).catch(() => undefined);
    return next;
  }

  private token(workspaceId: string): string {
    const file = this.orch.localPath('generated', workspaceId, 'wsd-token');
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    const token = randomBytes(32).toString('base64url');
    this.orch.writeWsdToken(workspaceId, token);
    return token;
  }

  ensureRunning(projectId: string): Promise<void> {
    return this.withLock(projectId, async () => {
      const ws = this.row(projectId);
      if (!ws) throw new HttpError(404, 'not_found', 'Workspace nicht gefunden');
      const project = this.db.get<{ git_url: string | null; name: string; repo_owner: string | null }>(
        'SELECT git_url, name, repo_owner FROM projects WHERE id = ?',
        projectId,
      );
      try {
        let containerId = ws.container_id;
        let info = containerId ? await this.orch.inspect(containerId) : null;
        if (!info) {
          this.setStatus(projectId, 'creating', 'Workspace wird erstellt …');
          await this.orch.ensureImage(ws.image, (progress) =>
            bus.project(projectId, { type: 'workspace.pull', projectId, progress }),
          );
          await this.orch.ensureNetwork();
          this.token(ws.id);
          containerId = await this.orch.createContainer({
            workspaceId: ws.id,
            projectId,
            image: ws.image,
            cpuLimit: ws.cpu_limit,
            memLimitMb: ws.mem_limit_mb,
            // Linked GitHub repos are cloned via RPC once credentials are pushed (github/service.ts).
            gitUrl: project?.repo_owner ? null : (project?.git_url ?? null),
            projectName: project?.name ?? null,
          });
          this.db.run('UPDATE workspaces SET container_id = ? WHERE id = ?', containerId, ws.id);
          info = await this.orch.inspect(containerId);
        } else {
          await this.orch.ensureNetwork();
        }
        if (!info!.State.Running) {
          this.setStatus(projectId, 'starting', 'Container startet …');
          await this.orch.start(containerId!);
        }
        await this.connect(projectId, ws.id, containerId!);
        this.setStatus(projectId, 'running');
      } catch (err) {
        this.setStatus(projectId, 'error', (err as Error).message);
        throw err;
      }
    });
  }

  private async connect(projectId: string, workspaceId: string, containerId: string) {
    let client = this.clients.get(projectId);
    if (!client) {
      client = new WsdClient(() => this.orch.wsdEndpoint(containerId), this.token(workspaceId));
      client.on('notification', (method: keyof WsdNotifications, params: unknown) =>
        this.onNotification(projectId, method, params),
      );
      client.on('open', () => {
        this.db.run('UPDATE workspaces SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), workspaceId);
        for (const fn of this.connectedListeners) {
          Promise.resolve(fn(projectId, client!)).catch((err: Error) => this.log.warn(`onConnected ${projectId}: ${err.message}`));
        }
      });
      this.clients.set(projectId, client);
      client.connect();
    }
    await client.waitOpen(60_000);
  }

  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly connectedListeners = new Set<ConnectedListener>();

  /** Subscribe to raw wsd notifications of all workspaces (used by feature services). */
  onWsdNotification(fn: NotificationListener): () => void {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  /** Called every time the connection to a workspace daemon (re)opens, e.g. to push credentials or resync. */
  onConnected(fn: ConnectedListener): () => void {
    this.connectedListeners.add(fn);
    return () => this.connectedListeners.delete(fn);
  }

  /** Project ids whose daemon is currently connected. */
  connectedProjects(): string[] {
    return [...this.clients.entries()].filter(([, c]) => c.connected).map(([id]) => id);
  }

  private onNotification(projectId: string, method: keyof WsdNotifications, params: unknown) {
    for (const fn of this.notificationListeners) {
      try {
        fn(projectId, method, params);
      } catch (err) {
        this.log.warn(`notification listener: ${(err as Error).message}`);
      }
    }
    switch (method) {
      case 'term.exit':
        bus.project(projectId, { type: 'term.exit', projectId, payload: params as WsdNotifications['term.exit'] });
        break;
      case 'fs.changed':
        bus.project(projectId, { type: 'fs.changed', projectId, paths: (params as WsdNotifications['fs.changed']).paths });
        break;
      case 'ports.changed':
        bus.project(projectId, { type: 'ports.changed', projectId, ports: (params as WsdNotifications['ports.changed']).ports });
        break;
      default:
        break;
    }
  }

  private dropClient(projectId: string) {
    this.clients.get(projectId)?.close();
    this.clients.delete(projectId);
  }

  stop(projectId: string): Promise<void> {
    return this.withLock(projectId, async () => {
      const ws = this.row(projectId);
      if (!ws?.container_id) return this.setStatus(projectId, 'stopped');
      this.dropClient(projectId);
      await this.orch.stop(ws.container_id).catch((err: { statusCode?: number }) => {
        if (err.statusCode !== 404) throw err;
      });
      this.setStatus(projectId, 'stopped');
    });
  }

  async restart(projectId: string) {
    await this.stop(projectId);
    await this.ensureRunning(projectId);
  }

  /** Removes the container (files and logins stay) and creates a fresh one, e.g. after an image update. */
  async recreate(projectId: string) {
    await this.withLock(projectId, async () => {
      const ws = this.row(projectId);
      this.dropClient(projectId);
      if (ws?.container_id) await this.orch.remove(ws.container_id);
      this.db.run('UPDATE workspaces SET container_id = NULL, image = ? WHERE project_id = ?', this.cfg.workspaceImage, projectId);
    });
    await this.ensureRunning(projectId);
  }

  async destroy(projectId: string, deleteFiles: boolean) {
    await this.withLock(projectId, async () => {
      const ws = this.row(projectId);
      this.dropClient(projectId);
      if (ws?.container_id) await this.orch.remove(ws.container_id);
      if (ws) rmSync(this.orch.localPath('generated', ws.id), { recursive: true, force: true });
      if (deleteFiles) rmSync(this.orch.localPath('projects', projectId), { recursive: true, force: true });
    });
  }

  /** Connected daemon client for a running workspace, or a 409 error. */
  client(projectId: string): WsdClient {
    const c = this.clients.get(projectId);
    if (!c?.connected) throw new HttpError(409, 'workspace_not_running', 'Workspace läuft nicht');
    return c;
  }

  /** Like client(), but waits up to timeoutMs for a running workspace's connection to come up. */
  async waitForClient(projectId: string, timeoutMs: number): Promise<WsdClient> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const c = this.clients.get(projectId);
      if (c?.connected) return c;
      const status = this.row(projectId)?.status;
      if (status !== 'running' && status !== 'starting' && status !== 'creating') break;
      if (c) await c.waitOpen(deadline - Date.now()).catch(() => undefined);
      else await new Promise((r) => setTimeout(r, 250));
    }
    return this.client(projectId);
  }

  /** Endpoint + bearer token of a running workspace's daemon, for the preview tunnel (`/proxy/<port>/…`). */
  async tunnelTarget(projectId: string): Promise<{ host: string; port: number; token: string }> {
    const ws = this.row(projectId);
    if (!ws?.container_id || ws.status !== 'running') throw new HttpError(409, 'workspace_not_running', 'Workspace läuft nicht');
    const ep = await this.orch.wsdEndpoint(ws.container_id);
    return { host: ep.host, port: ep.port, token: this.token(ws.id) };
  }

  /** Brings DB status in line with actual container state (on boot and periodically). */
  async reconcile() {
    const rows = this.db.all<WorkspaceRow>('SELECT * FROM workspaces');
    for (const ws of rows) {
      if (this.locks.has(ws.project_id)) continue;
      if (!ws.container_id) {
        if (ws.status !== 'none' && ws.status !== 'error') this.setStatus(ws.project_id, 'none');
        continue;
      }
      try {
        const info = await this.orch.inspect(ws.container_id);
        if (!info) {
          this.dropClient(ws.project_id);
          this.db.run('UPDATE workspaces SET container_id = NULL WHERE id = ?', ws.id);
          this.setStatus(ws.project_id, 'none', 'Container wurde extern entfernt');
        } else if (info.State.Running) {
          if (!this.clients.get(ws.project_id)?.connected) {
            await this.withLock(ws.project_id, () => this.connect(ws.project_id, ws.id, ws.container_id!));
          }
          if (ws.status !== 'running') this.setStatus(ws.project_id, 'running');
        } else if (ws.status === 'running' || ws.status === 'starting') {
          this.dropClient(ws.project_id);
          this.setStatus(ws.project_id, 'stopped');
        }
      } catch (err) {
        this.log.warn(`reconcile ${ws.project_id}: ${(err as Error).message}`);
      }
    }
  }

  startReconciler(intervalMs = 15_000) {
    void this.reconcile();
    this.reconcileTimer = setInterval(() => void this.reconcile(), intervalMs);
  }

  shutdown() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const id of [...this.clients.keys()]) this.dropClient(id);
  }
}
