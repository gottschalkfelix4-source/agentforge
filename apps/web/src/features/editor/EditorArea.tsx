import * as React from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { toast } from 'sonner';
import { AlertTriangle, Code2, FileWarning, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { setupMonaco } from '@/lib/monaco';
import { useUi } from '@/lib/store';
import { controlSocket } from '@/lib/ws';
import { basename, cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FileIcon } from '@/features/files/FileIcon';
import { languageFor } from './language';
import { useEditorStore, useProjectEditor, type EditorTab } from './store';
import { loadFileIntoTab } from './useOpenFile';

setupMonaco();

const modelUri = (projectId: string, path: string) => monaco.Uri.parse(`vibe://${projectId}/${path}`);

function disposeModel(projectId: string, path: string) {
  monaco.editor.getModel(modelUri(projectId, path))?.dispose();
}

const normalize = (p: string) => p.replace(/^\/workspace\/?/, '').replace(/^\.\//, '').replace(/^\//, '');

export async function saveTab(projectId: string, path: string) {
  const store = useEditorStore.getState();
  const tab = store.get(projectId).tabs.find((t) => t.path === path);
  if (!tab || tab.binary || tab.loading || tab.saving) return;
  const content = tab.content;
  store.patchTab(projectId, path, { saving: true });
  try {
    await api.writeFile(projectId, path, content);
    store.patchTab(projectId, path, { saving: false, saved: content });
  } catch (err) {
    store.patchTab(projectId, path, { saving: false });
    toast.error(`Speichern fehlgeschlagen: ${errorMessage(err)}`);
  }
}

export function EditorArea({ projectId }: { projectId: string }) {
  const { tabs, active } = useProjectEditor(projectId);
  const theme = useUi((s) => s.theme);
  const [confirmClose, setConfirmClose] = React.useState<string | null>(null);
  const activeTab = tabs.find((t) => t.path === active) ?? null;

  const activeRef = React.useRef<string | null>(active);
  activeRef.current = active;

  // Global Ctrl+S (also when focus is outside Monaco).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (activeRef.current) void saveTab(projectId, activeRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projectId]);

  // Reload clean tabs when files change on disk (e.g. edited by an agent).
  React.useEffect(
    () =>
      controlSocket.onEvent((ev) => {
        if (ev.type !== 'fs.changed' || ev.projectId !== projectId) return;
        const changed = new Set(ev.paths.map(normalize));
        for (const t of useEditorStore.getState().get(projectId).tabs) {
          if (changed.has(t.path) && t.content === t.saved && !t.saving && !t.binary) {
            void loadFileIntoTab(projectId, t.path);
          }
        }
      }),
    [projectId],
  );

  const close = (path: string, force = false) => {
    const tab = useEditorStore.getState().get(projectId).tabs.find((t) => t.path === path);
    if (!force && tab && tab.content !== tab.saved) {
      setConfirmClose(path);
      return;
    }
    useEditorStore.getState().closeTab(projectId, path);
    disposeModel(projectId, path);
  };

  const onMount: OnMount = (editor, m) => {
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
      if (activeRef.current) void saveTab(projectId, activeRef.current);
    });
  };

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-panel text-muted-foreground">
        <Code2 className="size-8 opacity-40" />
        <p className="text-sm">Datei im Explorer auswählen, um sie zu bearbeiten.</p>
        <p className="text-xs opacity-70">
          <kbd className="rounded border border-border px-1 font-mono">Strg</kbd>+
          <kbd className="rounded border border-border px-1 font-mono">S</kbd> speichert ·{' '}
          <kbd className="rounded border border-border px-1 font-mono">Strg</kbd>+
          <kbd className="rounded border border-border px-1 font-mono">`</kbd> Terminal
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-sidebar [scrollbar-width:none]">
        {tabs.map((t) => (
          <TabButton
            key={t.path}
            tab={t}
            active={t.path === active}
            onSelect={() => useEditorStore.getState().setActive(projectId, t.path)}
            onClose={() => close(t.path)}
          />
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        {activeTab?.loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : activeTab?.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="size-6 text-destructive" />
            <p>Datei konnte nicht geladen werden: {activeTab.error}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                useEditorStore.getState().patchTab(projectId, activeTab.path, { loading: true, error: null });
                void loadFileIntoTab(projectId, activeTab.path, { force: true });
              }}
            >
              Erneut laden
            </Button>
          </div>
        ) : activeTab?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-6 opacity-60" />
            <p>Binärdatei – kann im Editor nicht angezeigt werden.</p>
          </div>
        ) : activeTab ? (
          <Editor
            key={projectId}
            path={modelUri(projectId, activeTab.path).toString()}
            language={languageFor(activeTab.path)}
            value={activeTab.content}
            theme={theme === 'dark' ? 'vibe-dark' : 'vibe-light'}
            keepCurrentModel
            onMount={onMount}
            onChange={(v) => useEditorStore.getState().patchTab(projectId, activeTab.path, { content: v ?? '' })}
            loading={<Loader2 className="size-5 animate-spin text-muted-foreground" />}
            options={{
              fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              tabSize: 2,
              automaticLayout: true,
              renderLineHighlight: 'all',
              padding: { top: 8 },
              fixedOverflowWidgets: true,
              stickyScroll: { enabled: true },
            }}
          />
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmClose !== null}
        onOpenChange={(o) => !o && setConfirmClose(null)}
        title="Ungespeicherte Änderungen"
        description={`„${confirmClose ? basename(confirmClose) : ''}" hat ungespeicherte Änderungen. Trotzdem schließen?`}
        confirmLabel="Verwerfen"
        onConfirm={() => {
          if (confirmClose) close(confirmClose, true);
        }}
      />
    </div>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: EditorTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const dirty = tab.content !== tab.saved;
  return (
    <div
      role="tab"
      aria-selected={active}
      title={tab.path}
      onClick={onSelect}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className={cn(
        'group relative flex max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border pr-1.5 pl-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
        active && 'bg-panel text-foreground after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-brand',
      )}
    >
      <FileIcon name={basename(tab.path)} className="size-3.5" />
      <span className="truncate">{basename(tab.path)}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="relative ml-0.5 flex size-5 cursor-pointer items-center justify-center rounded hover:bg-accent"
        aria-label="Tab schließen"
      >
        {tab.saving ? (
          <Loader2 className="size-3 animate-spin" />
        ) : dirty ? (
          <>
            <span className="size-2 rounded-full bg-foreground/70 group-hover:hidden" />
            <X className="hidden size-3.5 group-hover:block" />
          </>
        ) : (
          <X className={cn('size-3.5', !active && 'opacity-0 group-hover:opacity-100')} />
        )}
      </button>
    </div>
  );
}
