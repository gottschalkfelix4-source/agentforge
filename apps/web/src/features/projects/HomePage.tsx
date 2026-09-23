import * as React from 'react';
import { Link } from 'react-router';
import { FolderPlus } from 'lucide-react';
import { useProjects } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Logo } from '@/features/auth/AuthGate';
import { NewProjectDialog } from './NewProjectDialog';
import { StatusDot, STATUS_LABEL, statusOf } from './status';

export function HomePage() {
  const projects = useProjects();
  const [open, setOpen] = React.useState(false);
  const list = (projects.data ?? []).filter((p) => !p.archived);

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-lg text-center">
        <Logo className="mx-auto mb-4 size-12" />
        <h1 className="text-xl font-semibold">Willkommen bei Agentforge</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Wähle ein Projekt aus der Seitenleiste oder lege ein neues an.
        </p>
        <Button variant="brand" className="mt-5" onClick={() => setOpen(true)}>
          <FolderPlus /> Neues Projekt
        </Button>
        {list.length > 0 && (
          <div className="mt-8 grid gap-1 text-left">
            <div className="px-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Zuletzt
            </div>
            {list.slice(0, 6).map((p) => (
              <Link
                key={p.id}
                to={`/p/${p.id}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2.5 transition-colors hover:bg-accent"
              >
                <StatusDot status={statusOf(p.workspace)} />
                <span className="truncate font-medium">{p.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{STATUS_LABEL[statusOf(p.workspace)]}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
      <NewProjectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
