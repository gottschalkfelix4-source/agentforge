import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentSession } from '@vibe/shared';
import { Loader2, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { useNav } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useAgents } from '@/lib/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PromptDialog } from '@/components/prompt-dialog';
import { chatApi, chatKeys, upsertSession, useSessions } from './api';
import { dropSessionStream } from './session-stream';
import { AgentAvatar, relativeTime, StatusDot, STATUS_LABEL, useTick } from './util';

const SessionRow = React.memo(function SessionRow({
  session,
  active,
  agentLabel,
  onSelect,
  onRename,
  onDelete,
}: {
  session: AgentSession;
  active: boolean;
  agentLabel: string;
  onSelect: (id: string) => void;
  onRename: (s: AgentSession) => void;
  onDelete: (s: AgentSession) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(session.id);
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
        active ? 'bg-accent text-foreground' : 'text-foreground/85 hover:bg-accent/60',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={session.status} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{session.title || 'Neue Session'}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-4 text-[11px] text-muted-foreground">
        <AgentAvatar agentId={session.agentId} label={agentLabel} className="size-3.5 text-[8px]" />
        <span className="truncate">{agentLabel}</span>
        <span className="opacity-50">·</span>
        <span className="shrink-0" title={new Date(session.updatedAt).toLocaleString('de-DE')}>
          {session.status === 'idle' || session.status === 'stopped'
            ? relativeTime(session.updatedAt)
            : STATUS_LABEL[session.status]}
        </span>
      </div>
      <div className="absolute top-1.5 right-1.5 hidden items-center gap-0.5 rounded-md bg-accent group-hover:flex">
        <button
          type="button"
          aria-label="Umbenennen"
          title="Umbenennen"
          onClick={(e) => {
            e.stopPropagation();
            onRename(session);
          }}
          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-background/60 hover:text-foreground"
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          aria-label="Löschen"
          title="Löschen"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(session);
          }}
          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-background/60 hover:text-destructive"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
});

export function SessionList({ projectId }: { projectId: string }) {
  useTick();
  const qc = useQueryClient();
  const sessions = useSessions(projectId);
  const agents = useAgents();
  const activeId = useNav((s) => s.activeSession[projectId]);
  const setActive = useNav((s) => s.setActiveSession);
  const [renaming, setRenaming] = React.useState<AgentSession | null>(null);
  const [deleting, setDeleting] = React.useState<AgentSession | null>(null);

  const labelOf = React.useCallback(
    (id: string) => agents.data?.find((a) => a.id === id)?.label ?? id,
    [agents.data],
  );
  const onSelect = React.useCallback((id: string) => setActive(projectId, id), [projectId, setActive]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2">
        <button
          type="button"
          onClick={() => setActive(projectId, undefined)}
          className={cn(
            'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
            !activeId ? 'bg-accent text-foreground' : 'text-foreground/85 hover:bg-accent/60',
          )}
        >
          <MessageSquarePlus className="size-4 text-muted-foreground" />
          Neue Session
        </button>
      </div>
      <div className="px-3 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">Sessions</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.isPending && (
          <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Lade…
          </div>
        )}
        {sessions.isError && <div className="px-2.5 py-2 text-xs text-destructive">Sessions konnten nicht geladen werden.</div>}
        {sessions.data?.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">Noch keine Sessions.</div>}
        <div className="flex flex-col gap-0.5">
          {sessions.data?.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              agentLabel={labelOf(s.agentId)}
              onSelect={onSelect}
              onRename={setRenaming}
              onDelete={setDeleting}
            />
          ))}
        </div>
      </div>

      {renaming && (
        <PromptDialog
          open
          onOpenChange={(o) => !o && setRenaming(null)}
          title="Session umbenennen"
          label="Titel"
          initialValue={renaming.title}
          confirmLabel="Speichern"
          onSubmit={async (title) => {
            const updated = await chatApi.rename(renaming.id, title.trim());
            upsertSession(qc, updated);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          title="Session löschen?"
          description={`„${deleting.title || 'Neue Session'}“ und der gesamte Verlauf werden gelöscht. Ein laufender Agent wird beendet.`}
          onConfirm={async () => {
            const id = deleting.id;
            await chatApi.remove(id);
            dropSessionStream(id);
            qc.setQueryData<AgentSession[]>(chatKeys.sessions(projectId), (old) => old?.filter((x) => x.id !== id));
            if (useNav.getState().activeSession[projectId] === id) setActive(projectId, undefined);
          }}
        />
      )}
    </div>
  );
}
