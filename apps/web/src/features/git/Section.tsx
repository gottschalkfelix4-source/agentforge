import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Collapsible section with a sticky-ish header and hover actions (VS Code SCM style). */
export function Section({
  title,
  count,
  actions,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="group/section flex h-7 items-center gap-1 pr-2 pl-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] font-medium text-foreground/70 normal-case">{count}</span>
          )}
        </button>
        {actions && <div className="flex items-center gap-0.5 opacity-70 group-hover/section:opacity-100">{actions}</div>}
      </div>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}
