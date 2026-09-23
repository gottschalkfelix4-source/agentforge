import { Radio } from 'lucide-react';
import { usePorts } from '@/lib/queries';
import { useNav } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function PortsIndicator({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const ports = usePorts(projectId, enabled);
  const list = [...(ports.data ?? [])].sort((a, b) => a.port - b.port);
  const count = list.length;
  const openPreview = useNav((s) => s.openPreview);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            count > 0 && 'text-foreground',
          )}
        >
          <Radio className={cn('size-3.5', count > 0 && 'text-success')} />
          {count === 0 ? 'Keine Ports' : count === 1 ? `Port ${list[0]!.port}` : `${count} Ports`}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Lauschende Ports</DropdownMenuLabel>
        {count === 0 ? (
          <DropdownMenuItem disabled>Aktuell lauscht kein Prozess.</DropdownMenuItem>
        ) : (
          list.map((p) => (
            <DropdownMenuItem
              key={`${p.address}:${p.port}`}
              className="font-mono text-xs"
              title="In der Vorschau öffnen"
              onSelect={() => openPreview(projectId, p.port)}
            >
              <span className="size-1.5 rounded-full bg-success" />
              {p.port}
              <span className="ml-auto text-muted-foreground">{p.address}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Klicke einen Port, um ihn in der Vorschau zu öffnen.</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
