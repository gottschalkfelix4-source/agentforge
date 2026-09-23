import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { relativeWire } from './paths.js';

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'dist']);
export const MAX_CHANGED_PATHS = 200;

export function isIgnoredPath(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return false;
  return rel.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
}

/** Watches the workspace and reports debounced, relative changed paths. */
export class WorkspaceWatcher {
  private watcher: FSWatcher | undefined;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly root: string,
    private readonly onChange: (paths: string[]) => void,
    private readonly debounceMs = 300,
  ) {}

  start(): void {
    const root = path.resolve(this.root);
    this.watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignored: (p: string) => isIgnoredPath(root, p),
    });
    const record = (p: string) => this.record(relativeWire(root, p));
    this.watcher
      .on('add', record)
      .on('change', record)
      .on('unlink', record)
      .on('addDir', record)
      .on('unlinkDir', record)
      .on('error', (err) => console.error('[wsd] watcher error:', (err as Error).message ?? err));
  }

  private record(rel: string): void {
    if (this.pending.size < MAX_CHANGED_PATHS) this.pending.add(rel);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs);
    }
  }

  private flush(): void {
    this.timer = undefined;
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length) this.onChange(paths);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
  }
}
