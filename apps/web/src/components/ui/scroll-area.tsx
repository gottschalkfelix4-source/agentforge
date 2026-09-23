import * as React from 'react';
import { cn } from '@/lib/utils';

export const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('min-h-0 overflow-auto overscroll-contain', className)} {...props} />
  ),
);
ScrollArea.displayName = 'ScrollArea';
