import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DeviceKind = 'desktop' | 'tablet' | 'mobile';
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface PreviewTab {
  id: string;
  port: number;
  /** Current in-app path (from the frame's `navigate` messages). */
  path: string;
  title: string;
}

interface TabsState {
  tabs: Record<string, PreviewTab[]>;
  active: Record<string, string | undefined>;
  device: DeviceKind;
  consoleOpen: boolean;
  addTab: (projectId: string, port: number, path?: string) => string;
  closeTab: (projectId: string, tabId: string) => void;
  setActive: (projectId: string, tabId: string) => void;
  updateTab: (projectId: string, tabId: string, patch: Partial<Omit<PreviewTab, 'id'>>) => void;
  setDevice: (d: DeviceKind) => void;
  setConsoleOpen: (v: boolean) => void;
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** Preview tabs per project (persisted, so tabs come back after a reload – with fresh tokens). */
export const usePreviewTabs = create<TabsState>()(
  persist(
    (set) => ({
      tabs: {},
      active: {},
      device: 'desktop',
      consoleOpen: false,
      addTab: (projectId, port, path = '/') => {
        const id = newId();
        set((s) => ({
          tabs: { ...s.tabs, [projectId]: [...(s.tabs[projectId] ?? []), { id, port, path, title: '' }] },
          active: { ...s.active, [projectId]: id },
        }));
        return id;
      },
      closeTab: (projectId, tabId) =>
        set((s) => {
          const list = s.tabs[projectId] ?? [];
          const idx = list.findIndex((t) => t.id === tabId);
          const next = list.filter((t) => t.id !== tabId);
          let active = s.active[projectId];
          if (active === tabId) active = next[Math.min(idx, next.length - 1)]?.id;
          return { tabs: { ...s.tabs, [projectId]: next }, active: { ...s.active, [projectId]: active } };
        }),
      setActive: (projectId, tabId) => set((s) => ({ active: { ...s.active, [projectId]: tabId } })),
      updateTab: (projectId, tabId, patch) =>
        set((s) => ({
          tabs: {
            ...s.tabs,
            [projectId]: (s.tabs[projectId] ?? []).map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
          },
        })),
      setDevice: (device) => set({ device }),
      setConsoleOpen: (consoleOpen) => set({ consoleOpen }),
    }),
    { name: 'vibe-preview' },
  ),
);

export interface ConsoleEntry {
  id: number;
  level: ConsoleLevel;
  text: string;
  stack?: string;
  ts: number;
}

interface TabLive {
  /** Bumped to (re)load the frame at `path` with a fresh token. */
  nonce: number;
  path: string | null;
  ready: boolean;
  lastAuthRetry: number;
}

interface LiveState {
  live: Record<string, TabLive>;
  logs: Record<string, ConsoleEntry[]>;
  load: (tabId: string, path?: string) => void;
  patch: (tabId: string, p: Partial<TabLive>) => void;
  pushLog: (tabId: string, e: Omit<ConsoleEntry, 'id'>) => void;
  clearLogs: (tabId: string) => void;
}

const MAX_LOGS = 1000;
let logSeq = 0;
const emptyLive: TabLive = { nonce: 0, path: null, ready: false, lastAuthRetry: 0 };

/** Non-persisted live state of preview frames (load requests, console output). */
export const usePreviewLive = create<LiveState>()((set) => ({
  live: {},
  logs: {},
  load: (tabId, path) =>
    set((s) => {
      const cur = s.live[tabId] ?? emptyLive;
      return { live: { ...s.live, [tabId]: { ...cur, nonce: cur.nonce + 1, path: path ?? null, ready: false } } };
    }),
  patch: (tabId, p) => set((s) => ({ live: { ...s.live, [tabId]: { ...(s.live[tabId] ?? emptyLive), ...p } } })),
  pushLog: (tabId, e) =>
    set((s) => {
      const list = s.logs[tabId] ?? [];
      const next = list.length >= MAX_LOGS ? list.slice(list.length - MAX_LOGS + 1) : list.slice();
      next.push({ ...e, id: ++logSeq });
      return { logs: { ...s.logs, [tabId]: next } };
    }),
  clearLogs: (tabId) => set((s) => ({ logs: { ...s.logs, [tabId]: [] } })),
}));

/** iframe elements by tab id (to match postMessage sources and send commands). */
export const frames = new Map<string, { el: HTMLIFrameElement; projectId: string; origin: string }>();
