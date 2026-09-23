import * as React from 'react';
import { CircleDot, GitMerge, GitPullRequest, Loader2, X, XCircle } from 'lucide-react';
import type { Label, TaskRunStatus } from '@vibe/shared';
import { cn } from '@/lib/utils';
import { Markdown } from '@/features/chat/Markdown';
import { Textarea } from '@/components/ui/textarea';

export function LabelChip({ label, onRemove, className }: { label: Pick<Label, 'name' | 'color'>; onRemove?: () => void; className?: string }) {
  const c = `#${label.color}`;
  return (
    <span
      className={cn('inline-flex max-w-40 items-center gap-1 truncate rounded-full border px-1.5 py-px text-[11px] leading-4 font-medium', className)}
      style={{
        backgroundColor: `color-mix(in oklab, ${c} 16%, transparent)`,
        borderColor: `color-mix(in oklab, ${c} 45%, transparent)`,
        color: `color-mix(in oklab, ${c} 70%, var(--foreground))`,
      }}
      title={label.name}
    >
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <button type="button" className="-mr-0.5 cursor-pointer rounded-full opacity-70 hover:opacity-100" onClick={onRemove} aria-label={`${label.name} entfernen`}>
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

export const RUN_STATUS: Record<TaskRunStatus, { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  running: { label: 'Agent arbeitet', cls: 'border-brand/30 bg-brand/10 text-brand', icon: Loader2 },
  awaiting_review: { label: 'Zu prüfen', cls: 'border-warning/30 bg-warning/10 text-warning', icon: CircleDot },
  pr_open: { label: 'PR offen', cls: 'border-success/30 bg-success/10 text-success', icon: GitPullRequest },
  merged: { label: 'Gemergt', cls: 'border-violet-500/30 bg-violet-500/10 text-violet-400', icon: GitMerge },
  failed: { label: 'Fehlgeschlagen', cls: 'border-destructive/30 bg-destructive/10 text-destructive', icon: XCircle },
  cancelled: { label: 'Abgebrochen', cls: 'border-border bg-muted text-muted-foreground', icon: X },
};

export function RunBadge({ status, className }: { status: TaskRunStatus; className?: string }) {
  const s = RUN_STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[11px] leading-4 font-medium whitespace-nowrap', s.cls, className)}>
      <Icon className={cn('size-3', status === 'running' && 'animate-spin')} />
      {s.label}
    </span>
  );
}

/** Markdown textarea with an edit / preview toggle. */
export function MarkdownField({
  value,
  onChange,
  projectId,
  placeholder,
  className,
  minHeight = 'min-h-40',
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  projectId: string;
  placeholder?: string;
  className?: string;
  minHeight?: string;
  autoFocus?: boolean;
}) {
  const [preview, setPreview] = React.useState(false);
  return (
    <div className={cn('flex min-h-0 flex-col rounded-lg border border-input', className)}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-1.5">
        {(['Bearbeiten', 'Vorschau'] as const).map((l, i) => (
          <button
            key={l}
            type="button"
            onClick={() => setPreview(i === 1)}
            className={cn(
              'h-6 cursor-pointer rounded-md px-2 text-xs font-medium transition-colors',
              preview === (i === 1) ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {l}
          </button>
        ))}
        <span className="ml-auto pr-1 text-[11px] text-muted-foreground">Markdown</span>
      </div>
      {preview ? (
        <div className={cn('min-h-0 flex-1 overflow-auto px-3 py-2', minHeight)}>
          {value.trim() ? <Markdown text={value} projectId={projectId} /> : <p className="text-sm text-muted-foreground">Nichts zu sehen.</p>}
        </div>
      ) : (
        <Textarea
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn('min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-[13px] focus-visible:ring-0', minHeight)}
        />
      )}
    </div>
  );
}

export function formatDate(d: string | null | undefined): string {
  if (!d) return '';
  const date = new Date(d.length === 10 ? `${d}T12:00:00` : d);
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(d: string | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

