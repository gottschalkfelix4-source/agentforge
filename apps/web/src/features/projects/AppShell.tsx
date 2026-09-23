import * as React from 'react';
import { Outlet } from 'react-router';
import { useControlSocketSync } from './live-sync';
import { Sidebar } from './Sidebar';
import { useUi } from '@/lib/store';

export function AppShell() {
  useControlSocketSync();

  // Global shortcut: Ctrl+` toggles the terminal panel.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        e.stopPropagation();
        useUi.getState().toggleTerminal();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <Outlet />
      </main>
    </div>
  );
}
