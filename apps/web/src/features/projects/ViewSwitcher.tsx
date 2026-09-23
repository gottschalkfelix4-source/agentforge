import { Bot, Code2, KanbanSquare, Milestone, NotebookPen } from 'lucide-react';
import { useUi, type ProjectViewKind } from '@/lib/store';
import { cn } from '@/lib/utils';

const VIEWS: { id: ProjectViewKind; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'code', label: 'Code', icon: Code2 },
  { id: 'board', label: 'Aufgaben', icon: KanbanSquare },
  { id: 'roadmap', label: 'Roadmap', icon: Milestone },
  { id: 'notes', label: 'Notizen', icon: NotebookPen },
];

/** Segmented control in the project header switching between the main project views. */
export function ViewSwitcher() {
  const view = useUi((s) => s.projectView);
  const setView = useUi((s) => s.setProjectView);
  return (
    <nav className="ml-2 flex items-center gap-0.5 rounded-lg border border-border bg-panel p-0.5" aria-label="Projektansicht">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => setView(v.id)}
          aria-current={view === v.id ? 'page' : undefined}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
            view === v.id ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <v.icon className="size-3.5" />
          <span className="hidden lg:inline">{v.label}</span>
        </button>
      ))}
    </nav>
  );
}
