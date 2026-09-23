import type { WorkspaceStatus } from '@vibe/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  none: 'Kein Workspace',
  creating: 'Wird erstellt',
  starting: 'Startet',
  running: 'Läuft',
  stopped: 'Gestoppt',
  error: 'Fehler',
};

export function statusOf(ws: { status: WorkspaceStatus } | null | undefined): WorkspaceStatus {
  return ws?.status ?? 'none';
}

export function isBusy(s: WorkspaceStatus) {
  return s === 'creating' || s === 'starting';
}

export function StatusDot({ status, className }: { status: WorkspaceStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        status === 'running' && 'bg-success shadow-[0_0_0_3px] shadow-success/15',
        isBusy(status) && 'animate-pulse bg-warning',
        (status === 'stopped' || status === 'none') && 'bg-muted-foreground/45',
        status === 'error' && 'bg-destructive',
        className,
      )}
      title={STATUS_LABEL[status]}
    />
  );
}

export function WorkspaceStatusBadge({ status }: { status: WorkspaceStatus }) {
  const variant =
    status === 'running' ? 'success' : isBusy(status) ? 'warning' : status === 'error' ? 'destructive' : 'outline';
  return (
    <Badge variant={variant}>
      <StatusDot status={status} className="size-1.5 shadow-none" />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
