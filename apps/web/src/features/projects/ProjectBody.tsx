import * as React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { GitBranch, Globe, X } from 'lucide-react';
import { useUi, type RightPanelKind } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ChatView } from '@/features/chat/ChatView';
import { GitPanel } from '@/features/git/GitPanel';
import { BoardView } from '@/features/pm/BoardView';
import { NotesView } from '@/features/pm/NotesView';
import { RoadmapView } from '@/features/pm/RoadmapView';
import { PreviewPanel } from '@/features/preview/PreviewPanel';
import { WorkspaceLayout } from './WorkspaceLayout';

const RIGHT_TABS: { id: RightPanelKind; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'preview', label: 'Vorschau', icon: Globe },
  { id: 'git', label: 'Git', icon: GitBranch },
];

/** Right side panel (preview browser / git). Panels stay mounted so iframes and state survive tab switches. */
function RightPanel({ projectId }: { projectId: string }) {
  const rightPanel = useUi((s) => s.rightPanel);
  const setRightPanel = useUi((s) => s.setRightPanel);
  return (
    <div className="flex h-full min-w-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        {RIGHT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setRightPanel(t.id)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
              rightPanel === t.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Panel schließen" onClick={() => setRightPanel(null)}>
          <X />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {RIGHT_TABS.map((t) => (
          <div key={t.id} className={cn('absolute inset-0', rightPanel !== t.id && 'invisible')}>
            {t.id === 'preview' ? <PreviewPanel projectId={projectId} /> : <GitPanel projectId={projectId} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function WithRightPanel({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const rightPanel = useUi((s) => s.rightPanel);
  return (
    <PanelGroup direction="horizontal" autoSaveId="vibe-layout-right">
      <Panel id="center" order={1} minSize={30} className="min-w-0">
        {children}
      </Panel>
      {rightPanel && (
        <>
          <PanelResizeHandle className="w-px shrink-0 bg-border transition-colors data-[resize-handle-state=drag]:bg-brand data-[resize-handle-state=hover]:bg-brand/60" />
          <Panel id="right" order={2} defaultSize={40} minSize={20} className="min-w-0">
            <RightPanel projectId={projectId} />
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}

/**
 * Body of a running project. Agent and code views stay mounted (terminals, chat streams and editors
 * must not reconnect); management views mount on demand.
 */
export function ProjectBody({
  projectId,
  running,
  workspaceFallback,
}: {
  projectId: string;
  running: boolean;
  /** Shown in the agent/code views while the workspace is not running. */
  workspaceFallback: React.ReactNode;
}) {
  const view = useUi((s) => s.projectView);
  const workspaceView = view === 'agent' || view === 'code';

  return (
    <div className="relative h-full">
      <div className={cn('absolute inset-0', !workspaceView && 'invisible')}>
        {running ? (
          <WithRightPanel projectId={projectId}>
            <div className="relative h-full">
              <div className={cn('absolute inset-0', view !== 'agent' && 'invisible')}>
                <ChatView projectId={projectId} />
              </div>
              <div className={cn('absolute inset-0', view !== 'code' && 'invisible')}>
                <WorkspaceLayout projectId={projectId} />
              </div>
            </div>
          </WithRightPanel>
        ) : (
          workspaceFallback
        )}
      </div>
      {view === 'board' && (
        <div className="absolute inset-0">
          <BoardView projectId={projectId} />
        </div>
      )}
      {view === 'roadmap' && (
        <div className="absolute inset-0">
          <RoadmapView projectId={projectId} />
        </div>
      )}
      {view === 'notes' && (
        <div className="absolute inset-0">
          <NotesView projectId={projectId} />
        </div>
      )}
    </div>
  );
}
