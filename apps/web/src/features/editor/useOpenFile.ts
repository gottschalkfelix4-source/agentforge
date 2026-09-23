import * as React from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import { useEditorStore } from './store';

export async function loadFileIntoTab(projectId: string, path: string, opts: { force?: boolean } = {}) {
  const store = useEditorStore.getState();
  try {
    const res = await api.readFile(projectId, path);
    const tab = useEditorStore.getState().get(projectId).tabs.find((t) => t.path === path);
    if (!tab) return;
    // Never clobber unsaved edits unless forced.
    if (!opts.force && tab.content !== tab.saved && !tab.loading) return;
    if (res.encoding === 'base64') {
      store.patchTab(projectId, path, { loading: false, binary: true, content: '', saved: '', error: null });
    } else {
      store.patchTab(projectId, path, { loading: false, binary: false, content: res.content, saved: res.content, error: null });
    }
  } catch (err) {
    store.patchTab(projectId, path, { loading: false, error: errorMessage(err) });
  }
}

export function useOpenFile(projectId: string) {
  return React.useCallback(
    (path: string) => {
      const created = useEditorStore.getState().openTab(projectId, path);
      if (created) void loadFileIntoTab(projectId, path);
    },
    [projectId],
  );
}
