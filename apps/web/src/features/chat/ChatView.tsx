// Phase 2 – structured agent chat incl. session list (owner: chat UI agent)
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AgentSession } from '@vibe/shared';
import {
  AlertTriangle,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Power,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useAgents } from '@/lib/queries';
import { useNav, useUi } from '@/lib/store';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PromptDialog } from '@/components/prompt-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { chatApi, chatKeys, upsertSession, useSession, useSessionActions, useSessions } from './api';
import { Composer, type ComposerImage } from './Composer';
import { ensureMonacoTheme } from './Markdown';
import { NewSession } from './NewSession';
import { SessionList } from './SessionList';
import { dropSessionStream, useTranscript } from './session-stream';
import { ThinkingIndicator } from './ThoughtBlock';
import { TranscriptView, UsageLine, UserBubble } from './TranscriptView';
import type { SessionInfo, TranscriptState } from './transcript';
import { AgentAvatar, StatusDot, STATUS_LABEL, usePersistentState } from './util';

/** Keep Monaco's global theme (used by the code-block colorizer) in sync with the app theme. */
function useMonacoTheme() {
  const theme = useUi((s) => s.theme);
  React.useEffect(() => ensureMonacoTheme(theme), [theme]);
}

export function ChatView({ projectId }: { projectId: string }) {
  useMonacoTheme();
  const [listOpen, setListOpen] = usePersistentState('vibe-chat-sessions-open', true);
  const activeId = useNav((s) => s.activeSession[projectId]);
  const setActive = useNav((s) => s.setActiveSession);
  const sessions = useSessions(projectId);
  const { session, missing } = useSession(projectId, activeId);

  // selected session does not exist (deleted elsewhere) → back to "new session"
  React.useEffect(() => {
    if (missing) setActive(projectId, undefined);
  }, [missing, projectId, setActive]);

  const toggle = (
    <Tooltip content={listOpen ? 'Sessions ausblenden' : 'Sessions einblenden'}>
      <Button variant="ghost" size="icon-sm" onClick={() => setListOpen(!listOpen)} aria-label="Sessionliste umschalten">
        {listOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
      </Button>
    </Tooltip>
  );

  return (
    <div className="flex h-full min-h-0 bg-background">
      {listOpen && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar/60">
          <SessionList projectId={projectId} />
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {activeId && session ? (
          <SessionPane key={session.id} projectId={projectId} session={session} toggle={toggle} />
        ) : activeId && !session && !sessions.isError ? (
          <div className="flex h-full flex-col">
            <div className="flex h-10 shrink-0 items-center px-2">{toggle}</div>
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          </div>
        ) : (
          <div className="relative flex h-full min-h-0 flex-col">
            <div className="absolute top-0 left-0 z-10 flex h-10 items-center px-2">{toggle}</div>
            <NewSession projectId={projectId} />
          </div>
        )}
      </main>
    </div>
  );
}

// ---- session pane ----------------------------------------------------------------------

interface PendingPrompt {
  text: string;
  images: ComposerImage[];
  userCount: number;
  /** Local send time — starts the "Denkt nach…" timer before the server echo arrives. */
  sentAt: number;
}

function countUserItems(s: TranscriptState): number {
  let n = 0;
  for (const t of s.turns) for (const i of t.items) if (i.kind === 'user') n++;
  return n;
}

function SessionPane({ projectId, session, toggle }: { projectId: string; session: AgentSession; toggle: React.ReactNode }) {
  const { state, error, reload } = useTranscript(session.id);
  const actions = useSessionActions(session.id);
  const agents = useAgents();
  const qc = useQueryClient();
  const setActive = useNav((s) => s.setActiveSession);
  const [pending, setPending] = React.useState<PendingPrompt | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [resuming, setResuming] = React.useState(false);

  const agentLabel = agents.data?.find((a) => a.id === session.agentId)?.label ?? session.agentId;
  const status = session.status;
  const running = status === 'running' || status === 'awaiting_approval';
  const stopped = status === 'stopped';
  const userCount = React.useMemo(() => countUserItems(state), [state]);

  // clear the optimistic bubble once the echo arrived
  React.useEffect(() => {
    if (pending && userCount > pending.userCount) setPending(null);
  }, [userCount, pending]);

  const info = React.useMemo(() => {
    const providerModels = session.providerModels;
    if (!state.info && !providerModels) return null;
    const base: SessionInfo = state.info ?? {
      externalId: session.externalId,
      models: [],
      currentModel: null,
      modes: [],
      currentMode: null,
      commands: [],
    };
    return {
      ...base,
      currentModel: base.currentModel ?? session.currentModel,
      currentMode: base.currentMode ?? session.currentMode,
      // Sessions with a provider profile (API key / own endpoint / Ollama) pick from the provider's models.
      ...(providerModels
        ? { models: providerModels.map((m) => ({ id: m, name: m })), currentModel: session.providerModel ?? providerModels[0] ?? null }
        : {}),
    };
  }, [state.info, session.currentModel, session.currentMode, session.providerModels, session.providerModel, session.externalId]);

  const switchModel = (id: string) => {
    if (!session.providerModels) return run(actions.model(id));
    if (id === (session.providerModel ?? null)) return;
    run(
      actions.model(id).then(() => toast.success(`Modell: ${id} – Agent wird mit dem neuen Modell fortgesetzt`)),
    );
  };

  const send = async (text: string, images: ComposerImage[]) => {
    setPending({ text, images, userCount, sentAt: Date.now() });
    try {
      await actions.prompt(
        text,
        images.map(({ mime, data }) => ({ mime, data })),
      );
      return true;
    } catch (err) {
      setPending(null);
      toast.error(errorMessage(err));
      return false;
    }
  };

  const resume = async () => {
    setResuming(true);
    try {
      await actions.resume();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setResuming(false);
    }
  };

  const run = (p: Promise<unknown>) => void p.catch((err) => toast.error(errorMessage(err)));

  const lastTurn = state.turns[state.turns.length - 1];
  const awaitingFirstOutput =
    status !== 'starting' &&
    status !== 'awaiting_approval' &&
    (!!pending || (running && !!lastTurn && !lastTurn.done && !lastTurn.items.some((i) => i.kind !== 'user')));

  const footer = (
    <>
      {pending && <UserBubble text={pending.text} images={pending.images} pending />}
      {awaitingFirstOutput ? (
        <ThinkingIndicator since={pending ? pending.sentAt : lastTurn?.startedAt} />
      ) : (running || status === 'starting') && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-brand" />
          {status === 'starting' ? 'Agent startet…' : status === 'awaiting_approval' ? 'Wartet auf deine Freigabe…' : 'Arbeitet…'}
        </div>
      )}
    </>
  );

  const empty = state.loaded && state.turns.length === 0 && !pending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        {toggle}
        <AgentAvatar agentId={session.agentId} label={agentLabel} />
        <button
          type="button"
          className="min-w-0 cursor-text truncate text-[13px] font-medium hover:text-foreground/80"
          onDoubleClick={() => setRenaming(true)}
          title="Doppelklick zum Umbenennen"
        >
          {session.title || 'Neue Session'}
        </button>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <StatusDot status={status} />
          {STATUS_LABEL[status]}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {state.usage && <UsageLine usage={state.usage} className="hidden md:block" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Session-Aktionen">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <Pencil /> Umbenennen
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={reload}>
                <RefreshCw /> Verlauf neu laden
              </DropdownMenuItem>
              {stopped || status === 'error' ? (
                <DropdownMenuItem onSelect={() => void resume()}>
                  <Play /> Fortsetzen
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => run(actions.stop())}>
                  <Power /> Agent beenden
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
                <Trash2 /> Löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* transcript */}
      {!state.loaded ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <AgentAvatar agentId={session.agentId} label={agentLabel} className="size-8 rounded-lg text-sm" />
          {status === 'starting' ? (
            <span className="flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin" /> {agentLabel} startet…
            </span>
          ) : (
            <span>Schreib {agentLabel}, was als Nächstes passieren soll.</span>
          )}
        </div>
      ) : (
        <TranscriptView
          state={state}
          projectId={projectId}
          approve={actions.approval}
          footer={footer}
          sessionKey={session.id}
        />
      )}

      {/* composer */}
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl">
          {error && (
            <div className="mb-2 flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="size-3.5" /> Verlauf konnte nicht geladen werden: {error}
              <button type="button" className="cursor-pointer underline" onClick={reload}>
                Erneut versuchen
              </button>
            </div>
          )}
          {(stopped || status === 'error') && (
            <div
              className={cn(
                'mb-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px]',
                stopped ? 'border-border bg-muted/40 text-muted-foreground' : 'border-destructive/40 bg-destructive/10 text-destructive',
              )}
            >
              {stopped ? <Power className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">
                {stopped ? 'Der Agent ist beendet.' : (session.statusMessage ?? 'Der Agent meldet einen Fehler.')}
              </span>
              <Button size="sm" variant={stopped ? 'brand' : 'outline'} onClick={() => void resume()} disabled={resuming}>
                {resuming ? <Loader2 className="animate-spin" /> : <Play />}
                {stopped ? 'Fortsetzen' : 'Neu starten'}
              </Button>
            </div>
          )}
          <Composer
            draftKey={session.id}
            disabled={stopped}
            disabledHint={stopped ? 'Session beendet' : undefined}
            running={running}
            onSend={send}
            onStop={actions.cancel}
            info={info}
            onModel={switchModel}
            modelsFromProvider={!!session.providerModels}
            onMode={(id) => run(actions.mode(id))}
            autoFocus
          />
        </div>
      </div>

      {renaming && (
        <PromptDialog
          open
          onOpenChange={setRenaming}
          title="Session umbenennen"
          label="Titel"
          initialValue={session.title}
          confirmLabel="Speichern"
          onSubmit={async (title) => {
            upsertSession(qc, await chatApi.rename(session.id, title.trim()));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={setDeleting}
          title="Session löschen?"
          description={`„${session.title || 'Neue Session'}“ und der gesamte Verlauf werden gelöscht. Ein laufender Agent wird beendet.`}
          onConfirm={async () => {
            await chatApi.remove(session.id);
            dropSessionStream(session.id);
            qc.setQueryData<AgentSession[]>(chatKeys.sessions(projectId), (old) => old?.filter((x) => x.id !== session.id));
            setActive(projectId, undefined);
          }}
        />
      )}
    </div>
  );
}
