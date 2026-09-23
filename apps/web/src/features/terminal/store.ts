import { create } from 'zustand';
import type { CreateTerminalRequest } from '@vibe/shared';

interface TerminalStore {
  /** Active terminal tab per project. */
  active: Record<string, string | undefined>;
  /** How a terminal was created (only known for terminals created by this browser) — used for restart. */
  origin: Record<string, CreateTerminalRequest | undefined>;
  /** Last measured terminal size, used for new terminals. */
  lastSize: { cols: number; rows: number } | null;
  setActive: (projectId: string, termId: string | undefined) => void;
  setOrigin: (termId: string, req: CreateTerminalRequest) => void;
  setLastSize: (cols: number, rows: number) => void;
}

export const useTerminalStore = create<TerminalStore>()((set) => ({
  active: {},
  origin: {},
  lastSize: null,
  setActive: (projectId, termId) => set((s) => ({ active: { ...s.active, [projectId]: termId } })),
  setOrigin: (termId, req) => set((s) => ({ origin: { ...s.origin, [termId]: req } })),
  setLastSize: (cols, rows) => set({ lastSize: { cols, rows } }),
}));
