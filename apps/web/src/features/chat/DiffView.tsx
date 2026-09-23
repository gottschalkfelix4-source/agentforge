import * as React from 'react';
import type { FileDiff } from '@vibe/shared';
import { ChevronRight, Columns2, FilePen, FilePlus2, FileX2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { diffStats, fileDiffLines, type DiffLine } from './diff';

const MonacoDiffDialog = React.lazy(() => import('./MonacoDiffDialog'));

const MAX_LINES = 400;

function DiffLines({ lines }: { lines: DiffLine[] }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? lines : lines.slice(0, MAX_LINES);
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[1.5] [font-variant-ligatures:none]">
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((l, i) =>
            l.kind === 'hunk' ? (
              <tr key={i} className="bg-muted/40 text-muted-foreground">
                <td colSpan={3} className="px-3 py-0.5 text-[11px]">
                  {l.text}
                </td>
              </tr>
            ) : (
              <tr
                key={i}
                className={cn(
                  l.kind === 'add' && 'bg-success/12',
                  l.kind === 'del' && 'bg-destructive/12',
                )}
              >
                <td className="w-9 min-w-9 pr-1.5 text-right align-top text-[11px] text-muted-foreground/60 select-none">
                  {l.kind === 'add' ? '' : l.oldNo}
                </td>
                <td className="w-9 min-w-9 pr-1.5 text-right align-top text-[11px] text-muted-foreground/60 select-none">
                  {l.kind === 'del' ? '' : l.newNo}
                </td>
                <td className="pr-3 whitespace-pre">
                  <span
                    className={cn(
                      'inline-block w-3.5 select-none',
                      l.kind === 'add' && 'text-success',
                      l.kind === 'del' && 'text-destructive',
                      l.kind === 'ctx' && 'text-transparent',
                    )}
                  >
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                  </span>
                  {l.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {!all && lines.length > MAX_LINES && (
        <button
          type="button"
          className="w-full cursor-pointer border-t border-border py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setAll(true)}
        >
          {lines.length - MAX_LINES} weitere Zeilen anzeigen
        </button>
      )}
    </div>
  );
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="font-mono text-[11px] tabular-nums">
      <span className="text-success">+{add}</span> <span className="text-destructive">−{del}</span>
    </span>
  );
}

/** One file of a diff with a header; collapsible. */
export const FileDiffView = React.memo(function FileDiffView({
  diff,
  defaultOpen,
  className,
}: {
  diff: FileDiff;
  defaultOpen?: boolean;
  className?: string;
}) {
  const lines = React.useMemo(() => fileDiffLines(diff), [diff]);
  const stats = React.useMemo(() => diffStats(diff), [diff]);
  const [open, setOpen] = React.useState(defaultOpen ?? lines.length <= 60);
  const [monaco, setMonaco] = React.useState(false);
  const Icon = diff.oldText === null && !diff.unified ? FilePlus2 : diff.newText === null && !diff.unified ? FileX2 : FilePen;
  const canMonaco = diff.oldText !== null || diff.newText !== null;
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-panel', className)}>
      <div className="flex h-7 items-center gap-1.5 pr-1 pl-2 text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-[12px]" title={diff.path}>
            {diff.path}
          </span>
          <DiffStat {...stats} />
        </button>
        {canMonaco && (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setMonaco(true)}
            title="Im Diff-Editor öffnen"
          >
            <Columns2 className="size-3" />
          </button>
        )}
      </div>
      {open && (
        <div className="max-h-[480px] overflow-y-auto border-t border-border">
          {lines.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">Keine inhaltlichen Änderungen</div>
          ) : (
            <DiffLines lines={lines} />
          )}
        </div>
      )}
      {monaco && (
        <React.Suspense fallback={null}>
          <MonacoDiffDialog diff={diff} open={monaco} onOpenChange={setMonaco} />
        </React.Suspense>
      )}
    </div>
  );
});

export function DiffList({ diffs, defaultOpen }: { diffs: FileDiff[]; defaultOpen?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      {diffs.map((d, i) => (
        <FileDiffView key={`${d.path}:${i}`} diff={d} defaultOpen={defaultOpen} />
      ))}
    </div>
  );
}
