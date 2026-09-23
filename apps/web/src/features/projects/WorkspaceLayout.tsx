import * as React from 'react';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { FileTree } from '@/features/files/FileTree';
import { TerminalPanel } from '@/features/terminal/TerminalPanel';

// Monaco is large — load the editor chunk only when a workspace is opened.
const EditorArea = React.lazy(() => import('@/features/editor/EditorArea').then((m) => ({ default: m.EditorArea })));

function ResizeHandle({ direction }: { direction: 'horizontal' | 'vertical' }) {
  return (
    <PanelResizeHandle
      className={cn(
        'relative shrink-0 bg-border transition-colors data-[resize-handle-state=drag]:bg-brand data-[resize-handle-state=hover]:bg-brand/60',
        direction === 'horizontal' ? 'w-px' : 'h-px',
        // larger hit area
        direction === 'horizontal'
          ? 'after:absolute after:inset-y-0 after:-left-1 after:w-2'
          : 'after:absolute after:inset-x-0 after:-top-1 after:h-2',
      )}
    />
  );
}

export function WorkspaceLayout({ projectId }: { projectId: string }) {
  const terminalVisible = useUi((s) => s.terminalVisible);
  const maximized = useUi((s) => s.terminalMaximized);
  const editorRef = React.useRef<ImperativePanelHandle>(null);
  const terminalRef = React.useRef<ImperativePanelHandle>(null);

  // Panels stay mounted (terminals must not reconnect) — we only collapse/expand them.
  React.useEffect(() => {
    const term = terminalRef.current;
    const editor = editorRef.current;
    if (!term || !editor) return;
    if (!terminalVisible) {
      editor.expand();
      term.collapse();
    } else if (maximized) {
      term.expand();
      editor.collapse();
    } else {
      editor.expand();
      term.expand();
    }
  }, [terminalVisible, maximized]);

  return (
    <PanelGroup direction="horizontal" autoSaveId="vibe-layout-h">
      <Panel id="tree" order={1} defaultSize={18} minSize={10} maxSize={45} className="min-w-0">
        <FileTree projectId={projectId} />
      </Panel>
      <ResizeHandle direction="horizontal" />
      <Panel id="main" order={2} minSize={30} className="min-w-0">
        <PanelGroup direction="vertical" autoSaveId="vibe-layout-v">
          <Panel
            id="editor"
            order={1}
            ref={editorRef}
            defaultSize={60}
            minSize={15}
            collapsible
            collapsedSize={0}
            onExpand={() => {
              if (useUi.getState().terminalMaximized) useUi.setState({ terminalMaximized: false });
            }}
          >
            <React.Suspense fallback={<div className="h-full bg-panel" />}>
              <EditorArea projectId={projectId} />
            </React.Suspense>
          </Panel>
          <ResizeHandle direction="vertical" />
          <Panel
            id="terminal"
            order={2}
            ref={terminalRef}
            defaultSize={40}
            minSize={12}
            collapsible
            collapsedSize={0}
            onCollapse={() => {
              if (useUi.getState().terminalVisible) useUi.setState({ terminalVisible: false, terminalMaximized: false });
            }}
            onExpand={() => {
              if (!useUi.getState().terminalVisible) useUi.setState({ terminalVisible: true });
            }}
          >
            <TerminalPanel projectId={projectId} running />
          </Panel>
        </PanelGroup>
      </Panel>
    </PanelGroup>
  );
}
