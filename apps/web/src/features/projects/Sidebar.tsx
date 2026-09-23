import * as React from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FolderGit2, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Plus, Settings, Sun, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { qk, useMe, useProjects } from '@/lib/queries';
import { useLive, useUi } from '@/lib/store';
import { controlSocket } from '@/lib/ws';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Logo } from '@/features/auth/AuthGate';
import { NewProjectDialog } from './NewProjectDialog';
import { StatusDot, statusOf } from './status';

export function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const wsConnected = useLive((s) => s.wsConnected);
  const projects = useProjects();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = React.useState(false);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    controlSocket.stop();
    qc.clear();
    qc.setQueryData(qk.me, { ...(me.data ?? { setupRequired: false, secretKeyFromEnv: true }), authenticated: false, username: null });
    navigate('/login', { replace: true });
  };

  const list = (projects.data ?? []).filter((p) => !p.archived);

  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2">
        <Tooltip content="Seitenleiste einblenden" side="right">
          <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
            <PanelLeftOpen />
          </Button>
        </Tooltip>
        <Tooltip content="Neues Projekt" side="right">
          <Button variant="ghost" size="icon-sm" onClick={() => setNewOpen(true)}>
            <Plus />
          </Button>
        </Tooltip>
        <div className="mt-2 flex flex-col items-center gap-1">
          {list.map((p) => (
            <Tooltip key={p.id} content={p.name} side="right">
              <NavLink
                to={`/p/${p.id}`}
                className={({ isActive }) =>
                  cn(
                    'relative flex size-8 items-center justify-center rounded-lg text-xs font-semibold uppercase text-muted-foreground hover:bg-accent',
                    isActive && 'bg-accent text-foreground',
                  )
                }
              >
                {p.name.slice(0, 2)}
                <StatusDot status={statusOf(p.workspace)} className="absolute right-0.5 bottom-0.5 size-1.5 shadow-none" />
              </NavLink>
            </Tooltip>
          ))}
        </div>
        <div className="mt-auto flex flex-col items-center gap-1">
          <Tooltip content="Einstellungen" side="right">
            <Button variant="ghost" size="icon-sm" onClick={() => navigate('/settings')}>
              <Settings />
            </Button>
          </Tooltip>
        </div>
        <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
      </aside>
    );
  }

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-12 items-center gap-2 px-3">
        <Logo className="size-6" />
        <span className="text-[15px] font-semibold tracking-tight">Agentforge</span>
        {!wsConnected && (
          <Tooltip content="Live-Verbindung getrennt – verbinde neu…">
            <WifiOff className="size-3.5 text-warning" />
          </Tooltip>
        )}
        <Tooltip content="Seitenleiste ausblenden">
          <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" onClick={toggleSidebar}>
            <PanelLeftClose />
          </Button>
        </Tooltip>
      </div>

      <div className="px-2 pb-2">
        <Button variant="outline" className="w-full justify-start bg-panel" onClick={() => setNewOpen(true)}>
          <Plus /> Neues Projekt
        </Button>
      </div>

      <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Projekte</div>
      <ScrollArea className="flex-1 px-2 pb-2">
        {projects.isPending ? (
          <div className="grid gap-1.5 px-1 py-1">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            <FolderGit2 className="mx-auto mb-2 size-5 opacity-60" />
            Noch keine Projekte
          </div>
        ) : (
          <nav className="grid gap-0.5">
            {list.map((p) => (
              <NavLink
                key={p.id}
                to={`/p/${p.id}`}
                className={({ isActive }) =>
                  cn(
                    'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground',
                    isActive && 'bg-accent font-medium text-foreground',
                  )
                }
              >
                <StatusDot status={statusOf(p.workspace)} />
                <span className="truncate">{p.name}</span>
              </NavLink>
            ))}
          </nav>
        )}
      </ScrollArea>

      <div className="flex items-center gap-1 border-t border-border p-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex h-8 flex-1 items-center gap-2 rounded-lg px-2.5 text-sm text-foreground/80 hover:bg-accent hover:text-foreground',
              isActive && 'bg-accent text-foreground',
            )
          }
        >
          <Settings className="size-4" /> Einstellungen
        </NavLink>
        <Tooltip content={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'} side="top">
          <Button variant="ghost" size="icon-sm" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <Tooltip content={`Abmelden${me.data?.username ? ` (${me.data.username})` : ''}`} side="top">
          <Button variant="ghost" size="icon-sm" onClick={logout}>
            <LogOut />
          </Button>
        </Tooltip>
      </div>
      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
    </aside>
  );
}
