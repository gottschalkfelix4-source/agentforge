import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, ProjectWithWorkspace, ServerEvent } from '@vibe/shared';
import { controlSocket } from '@/lib/ws';
import { qk } from '@/lib/queries';
import { useLive } from '@/lib/store';

/** Starts the shared control socket and maps server events onto react-query caches. */
export function useControlSocketSync() {
  const qc = useQueryClient();

  React.useEffect(() => {
    const { setWsConnected, setPullProgress } = useLive.getState();
    const offState = controlSocket.onState((connected) => {
      setWsConnected(connected);
      // after a reconnect we may have missed events — refresh the essentials
      if (connected) {
        void qc.invalidateQueries({ queryKey: qk.projects });
        void qc.invalidateQueries({ queryKey: ['project'] });
        void qc.invalidateQueries({ queryKey: ['terminals'] });
      }
    });

    const offEvent = controlSocket.onEvent((ev: ServerEvent) => {
      switch (ev.type) {
        case 'workspace.status': {
          const patch = (p: ProjectWithWorkspace): ProjectWithWorkspace =>
            p.id === ev.projectId && p.workspace
              ? { ...p, workspace: { ...p.workspace, status: ev.status, statusMessage: ev.message } }
              : p;
          qc.setQueryData<ProjectWithWorkspace[]>(qk.projects, (old) => old?.map(patch));
          qc.setQueryData<ProjectWithWorkspace>(qk.project(ev.projectId), (old) => (old ? patch(old) : old));
          void qc.invalidateQueries({ queryKey: qk.projects });
          void qc.invalidateQueries({ queryKey: qk.project(ev.projectId) });
          if (ev.status === 'running') {
            setPullProgress(ev.projectId, undefined);
            void qc.invalidateQueries({ queryKey: qk.terminals(ev.projectId) });
            void qc.invalidateQueries({ queryKey: qk.fsRoot(ev.projectId) });
            void qc.invalidateQueries({ queryKey: qk.ports(ev.projectId) });
          } else if (ev.status === 'error' || ev.status === 'stopped') {
            setPullProgress(ev.projectId, undefined);
            void qc.invalidateQueries({ queryKey: qk.terminals(ev.projectId) });
          }
          break;
        }
        case 'workspace.pull':
          setPullProgress(ev.projectId, ev.progress);
          break;
        case 'term.created':
        case 'term.exit':
          void qc.invalidateQueries({ queryKey: qk.terminals(ev.projectId) });
          break;
        case 'fs.changed':
          void qc.invalidateQueries({ queryKey: qk.fsRoot(ev.projectId) });
          break;
        case 'ports.changed':
          qc.setQueryData(qk.ports(ev.projectId), ev.ports);
          break;
        case 'projects.changed':
          void qc.invalidateQueries({ queryKey: qk.projects });
          break;
      }
    });

    controlSocket.start();
    const unsub = controlSocket.subscribe('projects');
    return () => {
      unsub();
      offEvent();
      offState();
      controlSocket.stop();
    };
  }, [qc]);
}

export function useChannel(ch: Channel | null) {
  React.useEffect(() => {
    if (!ch) return;
    return controlSocket.subscribe(ch);
  }, [ch]);
}
