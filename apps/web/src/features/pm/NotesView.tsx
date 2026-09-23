import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, FileText, Pin, PinOff, Plus, Search, StickyNote, Trash2 } from 'lucide-react';
import type { Note } from '@vibe/shared';
import { api } from '@/lib/api';
import { qk, useDir, useProject } from '@/lib/queries';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { relativeTime, useTick } from '@/features/chat/util';
import { pmApi, pmKeys, useNotes, usePmLive, usePmMutation } from './api';
import { EmptyHint, MarkdownField } from './common';

const SPECIAL_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
type SpecialFile = (typeof SPECIAL_FILES)[number];
type Selection = { kind: 'note'; id: string } | { kind: 'file'; name: SpecialFile } | null;

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

/** Debounced autosave: call `schedule(value)` on every change; flushes on unmount. */
function useAutosave<T>(save: (v: T) => Promise<unknown>, delay = 800) {
  const [state, setState] = React.useState<SaveState>('saved');
  const pending = React.useRef<{ v: T } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = React.useRef(save);
  saveRef.current = save;

  const flush = React.useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setState('saving');
    try {
      await saveRef.current(p.v);
      setState(pending.current ? 'dirty' : 'saved');
    } catch (err) {
      setState('error');
      toast.error(errorMessage(err));
    }
  }, []);

  const schedule = React.useCallback(
    (v: T) => {
      pending.current = { v };
      setState('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  React.useEffect(() => () => void flush(), [flush]);
  return { state, schedule, flush };
}

function SaveIndicator({ state }: { state: SaveState }) {
  const text = { saved: 'Gespeichert', dirty: 'Ungespeichert…', saving: 'Speichere…', error: 'Speichern fehlgeschlagen' }[state];
  return <span className={cn('text-xs', state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{text}</span>;
}

// ---- note editor ----------------------------------------------------------------------------

function NoteEditor({ projectId, note, onDeleted }: { projectId: string; note: Note; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = React.useState(note.title);
  const [body, setBody] = React.useState(note.body);
  const draft = React.useRef({ title: note.title, body: note.body });
  const { state, schedule } = useAutosave<{ title: string; body: string }>(async (v) => {
    const n = await pmApi.updateNote(note.id, { title: v.title.trim() || 'Ohne Titel', body: v.body });
    qc.setQueryData<Note[]>(pmKeys.notes(projectId), (old) => old?.map((x) => (x.id === n.id ? n : x)));
  });
  const pin = usePmMutation(projectId, () => pmApi.updateNote(note.id, { pinned: !note.pinned }));
  const remove = usePmMutation(projectId, () => pmApi.deleteNote(note.id));
  const [confirm, setConfirm] = React.useState(false);

  // Adopt remote edits while nothing is pending locally.
  React.useEffect(() => {
    if (state !== 'saved') return;
    if (note.title !== (draft.current.title.trim() || 'Ohne Titel')) setTitle((draft.current.title = note.title));
    if (note.body !== draft.current.body) setBody((draft.current.body = note.body));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.title, note.body]);

  const change = (patch: Partial<{ title: string; body: string }>) => {
    draft.current = { ...draft.current, ...patch };
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.body !== undefined) setBody(patch.body);
    schedule(draft.current);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Input value={title} onChange={(e) => change({ title: e.target.value })} className="h-9 border-transparent px-1.5 text-base font-semibold hover:border-input" aria-label="Titel" />
        <SaveIndicator state={state} />
        <Button size="icon-sm" variant="ghost" onClick={() => pin.mutate()} aria-label={note.pinned ? 'Lösen' : 'Anheften'} title={note.pinned ? 'Lösen' : 'Anheften'}>
          {note.pinned ? <PinOff /> : <Pin />}
        </Button>
        {confirm ? (
          <Button size="sm" variant="destructive" onClick={() => remove.mutate(undefined, { onSuccess: onDeleted })}>
            Löschen?
          </Button>
        ) : (
          <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(true)} aria-label="Löschen">
            <Trash2 />
          </Button>
        )}
      </div>
      <MarkdownField value={body} onChange={(v) => change({ body: v })} projectId={projectId} className="min-h-0 flex-1" minHeight="min-h-0" placeholder="Notizen in Markdown…" />
    </div>
  );
}

// ---- AGENTS.md / CLAUDE.md ------------------------------------------------------------------

function template(name: SpecialFile, projectName: string): string {
  const intro =
    name === 'CLAUDE.md'
      ? 'Diese Datei gibt Claude Code Kontext zu diesem Projekt. Sie wird bei jeder Sitzung automatisch gelesen.'
      : 'Anweisungen für Coding-Agents (Codex, Gemini, OpenCode, …), die in diesem Repository arbeiten.';
  return `# ${projectName}

${intro}

## Projektüberblick
- Was macht das Projekt? Für wen?
- Wichtige Verzeichnisse: \`src/\` …

## Setup & Befehle
- Abhängigkeiten installieren: \`npm install\`
- Entwicklungsserver: \`npm run dev\`
- Tests: \`npm test\`
- Lint/Format: \`npm run lint\`

## Code-Stil & Konventionen
- Sprache/Framework, Formatierung, Benennung
- Bevorzugte Bibliotheken und Muster

## Arbeitsweise
- Kleine, fokussierte Änderungen; Tests ergänzen, wenn sinnvoll
- Vor dem Commit: Tests und Linter ausführen
- Keine Secrets committen

## Hinweise
- Bekannte Stolperfallen, externe Dienste, Umgebungsvariablen
`;
}

function WorkspaceFileEditor({ projectId, name, exists }: { projectId: string; name: SpecialFile; exists: boolean }) {
  const qc = useQueryClient();
  const project = useProject(projectId);
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const { state, schedule } = useAutosave<string>((v) => api.writeFile(projectId, name, v));

  React.useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    if (!exists) return;
    api
      .readFile(projectId, name)
      .then((r) => {
        if (cancelled) return;
        if (r.encoding !== 'utf8') setError('Datei ist keine Textdatei');
        else setContent(r.content);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId, name, exists]);

  const create = async () => {
    setCreating(true);
    try {
      const text = template(name, project.data?.name ?? 'Projekt');
      await api.writeFile(projectId, name, text);
      setContent(text);
      await qc.invalidateQueries({ queryKey: qk.fs(projectId, '.') });
      toast.success(`${name} angelegt`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const header = (
    <div className="flex items-center gap-2">
      <Bot className="size-4 text-brand" />
      <span className="font-mono text-sm font-semibold">{name}</span>
      <span className="text-xs text-muted-foreground">im Workspace-Stammverzeichnis</span>
      {content !== null && (
        <span className="ml-auto">
          <SaveIndicator state={state} />
        </span>
      )}
    </div>
  );

  if (!exists && content === null) {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        {header}
        <div className="grid max-w-lg gap-3 rounded-xl border border-dashed border-border p-5 text-sm">
          <p>
            <span className="font-mono">{name}</span> existiert noch nicht.{' '}
            {name === 'CLAUDE.md'
              ? 'Claude Code liest diese Datei automatisch und nutzt sie als Projektkontext.'
              : 'Codex, Gemini CLI, OpenCode und andere Agents lesen AGENTS.md als Projektanweisungen.'}
          </p>
          <div>
            <Button variant="brand" size="sm" disabled={creating} onClick={() => void create()}>
              <Plus /> Mit Vorlage anlegen
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {header}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : content === null ? (
        <p className="text-sm text-muted-foreground">Lade…</p>
      ) : (
        <MarkdownField
          value={content}
          onChange={(v) => {
            setContent(v);
            schedule(v);
          }}
          projectId={projectId}
          className="min-h-0 flex-1"
          minHeight="min-h-0"
        />
      )}
    </div>
  );
}

// ---- view ------------------------------------------------------------------------------------

export function NotesView({ projectId }: { projectId: string }) {
  usePmLive(projectId);
  useTick(60_000);
  const notes = useNotes(projectId);
  const project = useProject(projectId);
  const running = project.data?.workspace?.status === 'running';
  const root = useDir(projectId, '.', running);
  const [query, setQuery] = React.useState('');
  const [sel, setSel] = React.useState<Selection>(null);
  const create = usePmMutation(projectId, () => pmApi.createNote(projectId, { title: 'Neue Notiz' }));

  const q = query.trim().toLowerCase();
  const list = (notes.data ?? []).filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
  const selectedNote = sel?.kind === 'note' ? notes.data?.find((n) => n.id === sel.id) : undefined;

  React.useEffect(() => {
    if (!sel && notes.data?.length) setSel({ kind: 'note', id: notes.data[0]!.id });
    if (sel?.kind === 'note' && notes.isSuccess && !notes.data.some((n) => n.id === sel.id)) setSel(null);
  }, [sel, notes.data, notes.isSuccess]);

  const existing = new Set((root.data ?? []).filter((e) => e.type === 'file').map((e) => e.name));

  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center gap-2 p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Notizen suchen…" className="pl-8" />
          </div>
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label="Neue Notiz"
            disabled={create.isPending}
            onClick={() => create.mutate(undefined, { onSuccess: (n) => setSel({ kind: 'note', id: n.id }) })}
          >
            <Plus />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Agent-Anweisungen</div>
          {SPECIAL_FILES.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setSel({ kind: 'file', name: f })}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                sel?.kind === 'file' && sel.name === f && 'bg-accent',
              )}
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 font-mono text-[13px]">{f}</span>
              {running && root.isSuccess && !existing.has(f) && <span className="text-[11px] text-muted-foreground">fehlt</span>}
            </button>
          ))}
          <div className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Notizen</div>
          {list.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSel({ kind: 'note', id: n.id })}
              className={cn(
                'grid w-full cursor-pointer gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
                sel?.kind === 'note' && sel.id === n.id && 'bg-accent',
              )}
            >
              <span className="flex items-center gap-1.5 text-sm">
                {n.pinned && <Pin className="size-3 shrink-0 text-brand" />}
                <span className="truncate font-medium">{n.title}</span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {relativeTime(n.updatedAt)} · {n.body.replace(/[#*`>\-\n]+/g, ' ').trim().slice(0, 60) || 'Leer'}
              </span>
            </button>
          ))}
          {notes.isSuccess && !list.length && (
            <p className="px-2 py-2 text-xs text-muted-foreground">{q ? 'Keine Treffer.' : 'Noch keine Notizen.'}</p>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {sel?.kind === 'file' ? (
          running ? (
            root.isSuccess ? (
              <WorkspaceFileEditor key={sel.name} projectId={projectId} name={sel.name} exists={existing.has(sel.name)} />
            ) : (
              <EmptyHint>Lade Workspace…</EmptyHint>
            )
          ) : (
            <EmptyHint>
              <span>
                <span className="font-mono">{sel.name}</span> liegt im Workspace. Starte den Workspace, um die Datei zu bearbeiten.
              </span>
            </EmptyHint>
          )
        ) : selectedNote ? (
          <NoteEditor key={selectedNote.id} projectId={projectId} note={selectedNote} onDeleted={() => setSel(null)} />
        ) : (
          <EmptyHint>
            <span className="grid justify-items-center gap-2">
              <StickyNote className="size-6" />
              Wähle eine Notiz oder lege eine neue an.
            </span>
          </EmptyHint>
        )}
      </main>
    </div>
  );
}
