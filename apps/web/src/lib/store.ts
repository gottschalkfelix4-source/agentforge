import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

/** Main views of a project (header switcher). */
export type ProjectViewKind = 'agent' | 'code' | 'board' | 'roadmap' | 'notes';
/** Right side panel tabs, shown next to the agent and code views. */
export type RightPanelKind = 'preview' | 'git';

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  terminalVisible: boolean;
  terminalMaximized: boolean;
  projectView: ProjectViewKind;
  rightPanel: RightPanelKind | null;
  setProjectView: (v: ProjectViewKind) => void;
  setRightPanel: (p: RightPanelKind | null) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalVisible: (v: boolean) => void;
  toggleTerminalMaximized: () => void;
}

function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  try {
    localStorage.setItem('vibe-theme', t);
  } catch {
    /* ignore */
  }
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      sidebarCollapsed: false,
      terminalVisible: true,
      terminalMaximized: false,
      projectView: 'agent',
      rightPanel: 'preview',
      setProjectView: (v) => set({ projectView: v }),
      setRightPanel: (p) => set({ rightPanel: p }),
      setTheme: (t) => {
        applyTheme(t);
        set({ theme: t });
      },
      toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleTerminal: () =>
        set((s) => (s.terminalVisible ? { terminalVisible: false, terminalMaximized: false } : { terminalVisible: true })),
      setTerminalVisible: (v) => set({ terminalVisible: v }),
      toggleTerminalMaximized: () =>
        set((s) => ({ terminalMaximized: !s.terminalMaximized, terminalVisible: true })),
    }),
    {
      name: 'vibe-ui',
      partialize: (s) => ({
        theme: s.theme,
        sidebarCollapsed: s.sidebarCollapsed,
        terminalVisible: s.terminalVisible,
        projectView: s.projectView,
        rightPanel: s.rightPanel,
      }),
      onRehydrateStorage: () => (s) => {
        if (s) applyTheme(s.theme);
      },
    },
  ),
);

/** Transient, non-persisted live state fed by the control socket. */
interface LiveState {
  wsConnected: boolean;
  pullProgress: Record<string, string | undefined>;
  setWsConnected: (v: boolean) => void;
  setPullProgress: (projectId: string, progress: string | undefined) => void;
}

export const useLive = create<LiveState>()((set) => ({
  wsConnected: false,
  pullProgress: {},
  setWsConnected: (v) => set({ wsConnected: v }),
  setPullProgress: (projectId, progress) =>
    set((s) => ({ pullProgress: { ...s.pullProgress, [projectId]: progress } })),
}));

/**
 * Cross-feature navigation requests (non-persisted), e.g. the chat asking the preview panel to open a port,
 * or the board opening an agent session.
 */
interface NavState {
  /** Selected agent session per project. */
  activeSession: Record<string, string | undefined>;
  /** Ask the preview panel to open a container port (nonce makes repeated requests distinct). */
  previewRequest: { projectId: string; port: number; path?: string; nonce: number } | null;
  setActiveSession: (projectId: string, sessionId: string | undefined) => void;
  openPreview: (projectId: string, port: number, path?: string) => void;
}

export const useNav = create<NavState>()((set) => ({
  activeSession: {},
  previewRequest: null,
  setActiveSession: (projectId, sessionId) =>
    set((s) => ({ activeSession: { ...s.activeSession, [projectId]: sessionId } })),
  openPreview: (projectId, port, path) => {
    useUi.setState({ rightPanel: 'preview' });
    set({ previewRequest: { projectId, port, path, nonce: Date.now() } });
  },
}));
