import * as React from 'react';
import { ArrowLeft, Loader2, Minus, Plus, Undo2 } from 'lucide-react';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useGitDiff } from './api';

interface Line {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Parses unified diff text into display lines with old/new line numbers. */
export function parseUnifiedDiff(diff: string): Line[] {
  const out: Line[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ') || raw.startsWith('old mode') || raw.startsWith('new mode')) {
      inHunk = false;
      out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) {
      out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      out.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) {
      if (raw) out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    else if (raw.startsWith('\\')) out.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    else if (raw.length || oldNo || newNo) out.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  // Drop the trailing empty context line produced by the final newline.
  while (out.length && out[out.length - 1]!.kind === 'ctx' && out[out.length - 1]!.text === '') out.pop();
  return out;
}

export function DiffView({
  projectId,
  path,
  staged,
  onBack,
  onStage,
  onUnstage,
  onDiscard,
}: {
  projectId: string;
  path: string;
  staged: boolean;
  onBack: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}) {
  const diff = useGitDiff(projectId, path, staged);
  const lines = React.useMemo(() => parseUnifiedDiff(diff.data?.diff ?? ''), [diff.data]);
  const stats = React.useMemo(
    () => ({ add: lines.filter((l) => l.kind === 'add').length, del: lines.filter((l) => l.kind === 'del').length }),
    [lines],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Zurück">
          <ArrowLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </span>
        <span className="text-[11px] text-muted-foreground">{staged ? 'gestaged' : 'Arbeitskopie'}</span>
        <span className="font-mono text-[11px] text-success">+{stats.add}</span>
        <span className="font-mono text-[11px] text-destructive">−{stats.del}</span>
        {onDiscard && (
          <Tooltip content="Änderungen verwerfen">
            <Button variant="ghost" size="icon-sm" onClick={onDiscard}>
              <Undo2 />
            </Button>
          </Tooltip>
        )}
        {onStage && (
          <Tooltip content="Stagen">
            <Button variant="ghost" size="icon-sm" onClick={onStage}>
              <Plus />
            </Button>
          </Tooltip>
        )}
        {onUnstage && (
          <Tooltip content="Unstagen">
            <Button variant="ghost" size="icon-sm" onClick={onUnstage}>
              <Minus />
            </Button>
          </Tooltip>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-background font-mono text-[12px] leading-[1.55]">
        {diff.isPending ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : diff.isError ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(diff.error)}</p>
        ) : lines.length === 0 ? (
          <p className="p-4 font-sans text-sm text-muted-foreground">Keine Änderungen (oder Binärdatei).</p>
        ) : (
          <table className="w-max min-w-full border-collapse">
            <tbody>
              {lines.map((l, i) => (
                <tr
                  key={i}
                  className={cn(
                    l.kind === 'add' && 'bg-success/10',
                    l.kind === 'del' && 'bg-destructive/10',
                    l.kind === 'hunk' && 'bg-brand/5 text-brand/80',
                    l.kind === 'meta' && 'text-muted-foreground',
                  )}
                >
                  <td className="w-10 px-1.5 text-right text-muted-foreground/60 select-none">{l.oldNo ?? ''}</td>
                  <td className="w-10 px-1.5 text-right text-muted-foreground/60 select-none">{l.newNo ?? ''}</td>
                  <td
                    className={cn(
                      'w-4 text-center select-none',
                      l.kind === 'add' && 'text-success',
                      l.kind === 'del' && 'text-destructive',
                    )}
                  >
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                  </td>
                  <td className="pr-4 whitespace-pre">{l.text || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
