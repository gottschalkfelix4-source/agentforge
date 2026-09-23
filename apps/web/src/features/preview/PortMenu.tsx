import * as React from 'react';
import type { ListeningPort } from '@vibe/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Inline "port number + open" form, used in menus and the empty state. */
export function ManualPortForm({ onPick, autoFocus }: { onPick: (port: number) => void; autoFocus?: boolean }) {
  const [value, setValue] = React.useState('');
  const port = Number(value);
  const valid = Number.isInteger(port) && port > 0 && port <= 65535;
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onPick(port);
          setValue('');
        }
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 5))}
        placeholder="Port, z. B. 5173"
        inputMode="numeric"
        className="h-7 font-mono text-xs"
        autoFocus={autoFocus}
        aria-label="Port"
      />
      <Button type="submit" size="sm" variant="secondary" disabled={!valid}>
        Öffnen
      </Button>
    </form>
  );
}

/** Dropdown listing the listening ports of the workspace plus manual entry. */
export function PortMenu({
  ports,
  current,
  onPick,
  children,
  align = 'start',
}: {
  ports: ListeningPort[];
  current?: number;
  onPick: (port: number) => void;
  children: React.ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuLabel>Lauschende Ports</DropdownMenuLabel>
        {ports.length === 0 ? (
          <DropdownMenuItem disabled>Kein Dev-Server erkannt</DropdownMenuItem>
        ) : (
          ports.map((p) => (
            <DropdownMenuItem key={`${p.address}:${p.port}`} className="font-mono text-xs" onSelect={() => onPick(p.port)}>
              <span className="size-1.5 rounded-full bg-success" />
              {p.port}
              {p.port === current && <span className="text-muted-foreground">(aktuell)</span>}
              <span className="ml-auto text-muted-foreground">{p.address}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <ManualPortForm
            onPick={(port) => {
              setOpen(false);
              onPick(port);
            }}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
