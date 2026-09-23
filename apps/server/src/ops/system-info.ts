import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type Docker from 'dockerode';
import { MANAGED_LABEL } from '../docker/orchestrator.js';

// ---- disk usage -------------------------------------------------------------

export interface DiskUsage {
  totalBytes: number;
  /** Size per top-level entry of the data dir, largest first. */
  entries: { name: string; bytes: number }[];
  /** True when the walk hit the entry/time budget; sizes are then lower bounds. */
  partial: boolean;
  computedAt: string;
}

export interface DiskUsageBudget {
  maxEntries: number;
  maxMs: number;
  maxDepth: number;
}

const DEFAULT_BUDGET: DiskUsageBudget = { maxEntries: 300_000, maxMs: 8_000, maxDepth: 64 };

/** du-style size of a directory (does not follow symlinks), bounded by entry count, time and depth. */
export async function diskUsage(dir: string, budget: DiskUsageBudget = DEFAULT_BUDGET): Promise<DiskUsage> {
  const deadline = Date.now() + budget.maxMs;
  let seen = 0;
  let partial = false;

  const walk = async (p: string, depth: number): Promise<number> => {
    if (++seen > budget.maxEntries || Date.now() > deadline) {
      partial = true;
      return 0;
    }
    let st;
    try {
      st = await lstat(p);
    } catch {
      return 0;
    }
    if (!st.isDirectory()) return st.size;
    if (depth >= budget.maxDepth) {
      partial = true;
      return 0;
    }
    let names: string[];
    try {
      names = await readdir(p);
    } catch {
      return 0;
    }
    let sum = 0;
    for (const n of names) sum += await walk(path.join(p, n), depth + 1);
    return sum;
  };

  const entries: { name: string; bytes: number }[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    /* data dir missing */
  }
  for (const name of names) entries.push({ name, bytes: await walk(path.join(dir, name), 1) });
  entries.sort((a, b) => b.bytes - a.bytes);
  return { totalBytes: entries.reduce((s, e) => s + e.bytes, 0), entries, partial, computedAt: new Date().toISOString() };
}

/** Caches the (potentially slow) disk usage walk. */
export class DiskUsageCache {
  private value: DiskUsage | null = null;
  private at = 0;
  private pending: Promise<DiskUsage> | null = null;

  constructor(private readonly dir: string, private readonly ttlMs = 60_000) {}

  get(force = false): Promise<DiskUsage> {
    if (!force && this.value && Date.now() - this.at < this.ttlMs) return Promise.resolve(this.value);
    this.pending ??= diskUsage(this.dir)
      .then((v) => {
        this.value = v;
        this.at = Date.now();
        return v;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

// ---- workspace image ----------------------------------------------------------

export interface ImageInfo {
  name: string;
  present: boolean;
  id: string | null;
  digest: string | null;
  created: string | null;
  sizeBytes: number | null;
  version: string | null;
}

export async function imageInfo(docker: Docker, name: string): Promise<ImageInfo> {
  try {
    const i = await docker.getImage(name).inspect();
    const env = i.Config?.Env ?? [];
    const version =
      i.Config?.Labels?.['org.opencontainers.image.version'] ??
      env.find((e) => e.startsWith('VIBE_VERSION='))?.slice('VIBE_VERSION='.length) ??
      null;
    return {
      name,
      present: true,
      id: i.Id,
      digest: i.RepoDigests?.[0] ?? null,
      created: i.Created ?? null,
      sizeBytes: i.Size ?? null,
      version,
    };
  } catch {
    return { name, present: false, id: null, digest: null, created: null, sizeBytes: null, version: null };
  }
}

/**
 * This instance's workspace containers (ids from the DB – other Agentforge instances may share the Docker host)
 * whose image differs from the current image id (→ need "Neu erstellen").
 */
export async function outdatedWorkspaces(docker: Docker, currentImageId: string | null, containerIds: string[]): Promise<number> {
  if (!currentImageId || containerIds.length === 0) return 0;
  const ours = new Set(containerIds);
  const list = await docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`, 'vibe.project'] } });
  return list.filter((c) => ours.has(c.Id) && c.ImageID && c.ImageID !== currentImageId).length;
}

// ---- image pull job -------------------------------------------------------------

export interface PullState {
  state: 'idle' | 'pulling' | 'done' | 'error';
  image: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string | null;
  error: string | null;
  /** True when the pull produced a different image id than before. */
  updated: boolean | null;
  previousId: string | null;
  currentId: string | null;
}

export const PULL_TIMEOUT_MS = 30 * 60_000;

/** A single background `docker pull` of the workspace image; state is polled by the UI. */
export class ImagePuller {
  private s: PullState;

  constructor(private readonly docker: Docker, private readonly image: string) {
    this.s = { state: 'idle', image, startedAt: null, finishedAt: null, progress: null, error: null, updated: null, previousId: null, currentId: null };
  }

  state(): PullState {
    return { ...this.s };
  }

  /** Starts a pull unless one is already running. */
  start(log: { info: (m: string) => void; warn: (m: string) => void }): PullState {
    if (this.s.state === 'pulling') return this.state();
    this.s = { ...this.s, state: 'pulling', startedAt: new Date().toISOString(), finishedAt: null, progress: 'Starte …', error: null, updated: null };
    void this.run()
      .then(() => log.info(`Workspace-Image ${this.image} aktualisiert (neu: ${this.s.updated ? 'ja' : 'nein'}).`))
      .catch((err: Error) => {
        this.s = { ...this.s, state: 'error', error: err.message, finishedAt: new Date().toISOString() };
        log.warn(`Workspace-Image ${this.image} konnte nicht gezogen werden: ${err.message}`);
      });
    return this.state();
  }

  private async run() {
    const before = await imageInfo(this.docker, this.image);
    this.s.previousId = before.id;
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.docker.pull(this.image);
    } catch (err) {
      throw new Error(
        `${(err as Error).message}. Lokal gebaute Images (ohne Registry, z. B. agentforge-workspace:dev) können nicht gezogen werden – ` +
          'neu bauen mit: docker build -f docker/workspace/Dockerfile -t <image> .',
      );
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        (stream as unknown as { destroy?: () => void }).destroy?.();
        reject(new Error('Zeitüberschreitung beim Ziehen des Images'));
      }, PULL_TIMEOUT_MS);
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        },
        (ev: { status?: string; progress?: string; id?: string; error?: string }) => {
          if (ev.error) return;
          this.s.progress = [ev.id, ev.status, ev.progress].filter(Boolean).join(' ');
        },
      );
    });
    const after = await imageInfo(this.docker, this.image);
    this.s = {
      ...this.s,
      state: 'done',
      progress: null,
      finishedAt: new Date().toISOString(),
      currentId: after.id,
      updated: !!after.id && after.id !== before.id,
    };
  }
}
