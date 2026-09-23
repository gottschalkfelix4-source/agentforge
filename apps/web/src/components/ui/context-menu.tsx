import * as React from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { cn } from '@/lib/utils';

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

export const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn('z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 text-foreground shadow-xl', className)}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = 'ContextMenuContent';

export const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
      destructive && 'text-destructive [&_svg]:text-destructive',
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = 'ContextMenuItem';

export function ContextMenuSeparator() {
  return <ContextMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}
