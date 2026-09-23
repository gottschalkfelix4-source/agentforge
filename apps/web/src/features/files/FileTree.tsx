import * as React from 'react';
import { create } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, FilePlus, FolderPlus, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { FsEntry } from '@vibe/shared';
import { api } from '@/lib/api';
import { qk, useDir } from '@/lib/queries';
import { basename, cn, dirname, errorMessage, joinPath } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { PromptDialog } from '@/components/prompt-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useEditorStore, useProjectEditor } from '@/features/editor/store';
import { useOpenFile } from '@/features/editor/useOpenFile';
import { FileIcon } from './FileIcon';

// ---- expanded-dirs state (per project, survives remounts) -------------------

interface TreeState {
  expanded: Record<string, Record<string, boolean>>;
  toggle: (projectId: string, path: string, open?: boolean) => void;
}
const useTreeState = create<TreeState>()((set) => ({
  expanded: {},
  toggle: (projectId, path, open) =>
    set((s) => {
      const cur = s.expanded[projectId] ?? {};
      const next = open ?? !cur[path];
      return { expanded: { ...s.expanded, [projectId]: { ...cur, [path]: next } } };
    }),
}));

type Action =
  | { kind: 'newFile'; dir: string }
  | { kind: 'newDir'; dir: string }
  | { kind: 'rename'; entry: FsEntry }
  | { kind: 'delete'; entry: FsEntry };

interface TreeCtx {
  projectId: string;
  activePath: string | null;
  openFile: (path: string) => void;
  act: (a: Action) => void;
}
const Ctx = React.createContext<TreeCtx | null>(null);
const useCtx = () => React.useContext(Ctx)!;

function sortEntries(entries: FsEntry[]) {
  return [...entries].sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

export function FileTree({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const openFile = useOpenFile(projectId);
  const { active } = useProjectEditor(projectId);
  const [action, setAction] = React.useState<Action | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: qk.fsRoot(projectId) });
  const invalidateDir = (dir: string) => void qc.invalidateQueries({ queryKey: qk.fs(projectId, dir) });

  const ctx = React.useMemo<TreeCtx>(
    () => ({ projectId, activePath: active, openFile, act: setAction }),
    [projectId, active, openFile],
  );

  // PromptDialog / ConfirmDialog show error toasts themselves.
  const run = (fn: () => Promise<unknown>) => fn();

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col bg-sidebar">
        <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pr-1 pl-3">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Explorer</span>
          <div className="ml-auto flex items-center">
            <Tooltip content="Neue Datei">
              <Button variant="ghost" size="icon-xs" onClick={() => setAction({ kind: 'newFile', dir: '.' })}>
                <FilePlus />
              </Button>
            </Tooltip>
            <Tooltip content="Neuer Ordner">
              <Button variant="ghost" size="icon-xs" onClick={() => setAction({ kind: 'newDir', dir: '.' })}>
                <FolderPlus />
              </Button>
            </Tooltip>
            <Tooltip content="Aktualisieren">
              <Button variant="ghost" size="icon-xs" onClick={refresh}>
                <RefreshCw />
              </Button>
            </Tooltip>
          </div>
        </div>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <ScrollArea className="flex-1 py-1 text-[13px]">
              <DirChildren path="." depth={0} />
              <div className="h-8" />
            </ScrollArea>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => setAction({ kind: 'newFile', dir: '.' })}>
              <FilePlus /> Neue Datei
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => setAction({ kind: 'newDir', dir: '.' })}>
              <FolderPlus /> Neuer Ordner
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={refresh}>
              <RefreshCw /> Aktualisieren
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <PromptDialog
        open={action?.kind === 'newFile' || action?.kind === 'newDir'}
        onOpenChange={(o) => !o && setAction(null)}
        title={action?.kind === 'newDir' ? 'Neuer Ordner' : 'Neue Datei'}
        description={
          action && 'dir' in action && action.dir !== '.' ? (
            <span className="font-mono text-xs">in {action.dir}/</span>
          ) : undefined
        }
        placeholder={action?.kind === 'newDir' ? 'ordner' : 'datei.ts'}
        confirmLabel="Erstellen"
        onSubmit={(name) =>
          run(async () => {
            if (!action || !('dir' in action)) return;
            const path = joinPath(action.dir, name.replace(/^\/+/, ''));
            if (action.kind === 'newDir') await api.mkdir(projectId, path);
            else await api.writeFile(projectId, path, '');
            if (action.dir !== '.') useTreeState.getState().toggle(projectId, action.dir, true);
            invalidateDir(action.dir);
            // nested names like "a/b.ts" create intermediate dirs server-side
            if (name.includes('/')) refresh();
            if (action.kind === 'newFile') openFile(path);
          })
        }
      />

      <PromptDialog
        open={action?.kind === 'rename'}
        onOpenChange={(o) => !o && setAction(null)}
        title="Umbenennen"
        initialValue={action?.kind === 'rename' ? action.entry.name : ''}
        confirmLabel="Umbenennen"
        onSubmit={(name) =>
          run(async () => {
            if (action?.kind !== 'rename') return;
            const from = action.entry.path;
            const to = joinPath(dirname(from), name);
            if (to === from) return;
            await api.rename(projectId, from, to);
            useEditorStore.getState().renamePath(projectId, from, to);
            invalidateDir(dirname(from));
          })
        }
      />

      <ConfirmDialog
        open={action?.kind === 'delete'}
        onOpenChange={(o) => !o && setAction(null)}
        title={action?.kind === 'delete' && action.entry.type === 'dir' ? 'Ordner löschen?' : 'Datei löschen?'}
        description={
          action?.kind === 'delete' ? (
            <>
              <span className="font-mono text-foreground">{action.entry.path}</span> wird dauerhaft gelöscht.
            </>
          ) : undefined
        }
        onConfirm={() =>
          run(async () => {
            if (action?.kind !== 'delete') return;
            await api.deletePath(projectId, action.entry.path);
            useEditorStore.getState().closeUnder(projectId, action.entry.path);
            invalidateDir(dirname(action.entry.path));
          })
        }
      />
    </Ctx.Provider>
  );
}

function DirChildren({ path, depth }: { path: string; depth: number }) {
  const { projectId } = useCtx();
  const q = useDir(projectId, path);
  const pad = 8 + depth * 12;

  if (q.isPending) {
    return (
      <div className="grid gap-1 py-1 pr-3" style={{ paddingLeft: pad + 18 }}>
        <Skeleton className="h-4 w-3/4" />
        {depth === 0 && (
          <>
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </>
        )}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="py-1 pr-3 text-xs text-destructive" style={{ paddingLeft: pad + 18 }}>
        {errorMessage(q.error)}
      </div>
    );
  }
  if (q.data.length === 0) {
    return (
      <div className="py-1 pr-3 text-xs text-muted-foreground/70 italic" style={{ paddingLeft: pad + 18 }}>
        {depth === 0 ? 'Workspace ist leer' : 'leer'}
      </div>
    );
  }
  return (
    <>
      {sortEntries(q.data).map((e) => (
        <TreeNode key={e.path} entry={e} depth={depth} />
      ))}
    </>
  );
}

function TreeNode({ entry, depth }: { entry: FsEntry; depth: number }) {
  const { projectId, activePath, openFile, act } = useCtx();
  const isDir = entry.type === 'dir';
  const expanded = useTreeState((s) => !!s.expanded[projectId]?.[entry.path]);
  const toggle = useTreeState((s) => s.toggle);
  const selected = activePath === entry.path;
  const dim = entry.name === 'node_modules' || entry.name === '.git';

  const onClick = () => {
    if (isDir) toggle(projectId, entry.path);
    else openFile(entry.path);
  };

  const targetDir = isDir ? entry.path : dirname(entry.path);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-expanded={isDir ? expanded : undefined}
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              } else if (e.key === 'F2') act({ kind: 'rename', entry });
              else if (e.key === 'Delete') act({ kind: 'delete', entry });
            }}
            title={entry.path}
            className={cn(
              'flex h-[26px] cursor-pointer items-center gap-1.5 pr-2 outline-none select-none hover:bg-accent/70 focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset',
              selected && 'bg-accent text-foreground',
              dim && 'opacity-60',
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            {isDir ? (
              <ChevronRight
                className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
              />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <FileIcon name={entry.name} dir={isDir} open={expanded} />
            <span className="truncate">{entry.name}</span>
            {entry.type === 'symlink' && <span className="text-[10px] text-muted-foreground">↪</span>}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => act({ kind: 'newFile', dir: targetDir })}>
            <FilePlus /> Neue Datei
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => act({ kind: 'newDir', dir: targetDir })}>
            <FolderPlus /> Neuer Ordner
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => act({ kind: 'rename', entry })}>
            <Pencil /> Umbenennen
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => act({ kind: 'delete', entry })}>
            <Trash2 /> Löschen
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard?.writeText(entry.path);
              toast.success(`Pfad kopiert: ${basename(entry.path)}`);
            }}
          >
            Pfad kopieren
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isDir && expanded && <DirChildren path={entry.path} depth={depth + 1} />}
    </>
  );
}
