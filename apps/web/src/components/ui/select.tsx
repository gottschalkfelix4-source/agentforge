import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Native select, styled. */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className={cn('relative', className)}>
      <select
        ref={ref}
        className="h-8 w-full appearance-none rounded-lg border border-input bg-transparent pr-8 pl-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-50 [&>option]:bg-popover [&>option]:text-foreground"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  ),
);
Select.displayName = 'Select';
