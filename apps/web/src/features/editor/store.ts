import { create } from 'zustand';

export interface EditorTab {
  path: string;
  content: string;
  saved: string;
  loading: boolean;
  saving: boolean;
  binary: boolean;
  error: string | null;
}

interface ProjectEditorState {
  tabs: EditorTab[];
  active: string | null;
}

interface EditorStore {
  byProject: Record<string, ProjectEditorState>;
  get: (projectId: string) => ProjectEditorState;
  openTab: (projectId: string, path: string) => boolean;
  patchTab: (projectId: string, path: string, patch: Partial<EditorTab>) => void;
  setActive: (projectId: string, path: string | null) => void;
  closeTab: (projectId: string, path: string) => void;
  closeUnder: (projectId: string, path: string) => void;
  renamePath: (projectId: string, from: string, to: string) => void;
}

const EMPTY: ProjectEditorState = { tabs: [], active: null };

const isUnder = (p: string, base: string) => p === base || p.startsWith(`${base}/`);

export const useEditorStore = create<EditorStore>()((set, get) => {
  const update = (projectId: string, fn: (s: ProjectEditorState) => ProjectEditorState) =>
    set((st) => ({ byProject: { ...st.byProject, [projectId]: fn(st.byProject[projectId] ?? EMPTY) } }));

  return {
    byProject: {},
    get: (projectId) => get().byProject[projectId] ?? EMPTY,

    /** Returns true if the tab was newly created (caller should load content). */
    openTab: (projectId, path) => {
      const existing = get().get(projectId).tabs.some((t) => t.path === path);
      update(projectId, (s) => ({
        active: path,
        tabs: existing
          ? s.tabs
          : [...s.tabs, { path, content: '', saved: '', loading: true, saving: false, binary: false, error: null }],
      }));
      return !existing;
    },

    patchTab: (projectId, path, patch) =>
      update(projectId, (s) => ({ ...s, tabs: s.tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)) })),

    setActive: (projectId, path) => update(projectId, (s) => ({ ...s, active: path })),

    closeTab: (projectId, path) =>
      update(projectId, (s) => {
        const idx = s.tabs.findIndex((t) => t.path === path);
        const tabs = s.tabs.filter((t) => t.path !== path);
        let active = s.active;
        if (active === path) active = tabs[Math.min(idx, tabs.length - 1)]?.path ?? null;
        return { tabs, active };
      }),

    closeUnder: (projectId, path) =>
      update(projectId, (s) => {
        const tabs = s.tabs.filter((t) => !isUnder(t.path, path));
        const active = s.active && isUnder(s.active, path) ? (tabs[tabs.length - 1]?.path ?? null) : s.active;
        return { tabs, active };
      }),

    renamePath: (projectId, from, to) =>
      update(projectId, (s) => {
        const map = (p: string) => (isUnder(p, from) ? to + p.slice(from.length) : p);
        return {
          tabs: s.tabs.map((t) => ({ ...t, path: map(t.path) })),
          active: s.active ? map(s.active) : null,
        };
      }),
  };
});

export function useProjectEditor(projectId: string) {
  return useEditorStore((s) => s.byProject[projectId] ?? EMPTY);
}
