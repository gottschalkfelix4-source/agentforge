import * as React from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';

export interface ThoughtViewProps {
  projectId: string;
  text: string;
  done: boolean;
  /** Duration reported by the adapter (ms). */
  durationMs?: number;
  /** Event timestamps (ms) — fallback for the duration and the live timer. */
  startedAt?: number;
  endedAt?: number;
  /** Heading while thinking is still running, e.g. a "think" tool title. */
  title?: string;
}

function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
}

/** Seconds since `since`, ticking once per second while `active`. */
function useElapsed(active: boolean, since: number | undefined): number {
  const [mountedAt] = React.useState(() => Date.now());
  const start = since ?? mountedAt;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.max(0, now - start);
}

/**
 * Thought process of an agent (Claude desktop style):
 * - while thinking: header "Denkt nach… 5 s" and a live, auto-scrolling preview of the latest lines
 * - afterwards: collapsed to "Nachgedacht für 12 s", expandable to the full text
 */
export function ThoughtView({ projectId, text, done, durationMs, startedAt, endedAt, title }: ThoughtViewProps) {
  const [expanded, setExpanded] = React.useState(false);
  const previewRef = React.useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = React.useState(false);
  const elapsed = useElapsed(!done, startedAt);
  const hasText = text.trim().length > 0;

  // Keep the live preview pinned to the newest text.
  React.useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el || done || expanded) return;
    el.scrollTop = el.scrollHeight;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, done, expanded]);

  if (done && !hasText) return null;

  const total = durationMs ?? (startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined);
  const label = !done
    ? `${title ?? 'Denkt nach'}… ${elapsed >= 1000 ? formatDuration(elapsed) : ''}`.trim()
    : total !== undefined && total >= 1000
      ? `Nachgedacht für ${formatDuration(total)}`
      : 'Gedankengang';

  return (
    <div className="text-[13px]">
      <button
        type="button"
        disabled={!hasText}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="group flex items-center gap-1.5 text-muted-foreground transition-colors enabled:cursor-pointer enabled:hover:text-foreground"
      >
        <Brain className={cn('size-3.5', !done && 'text-brand')} />
        <span className={cn('tabular-nums', !done && 'thinking-shimmer')}>{label}</span>
        {hasText && <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />}
      </button>

      {hasText && expanded && (
        <div className="mt-1.5 ml-[7px] border-l-2 border-border pl-3.5 text-muted-foreground">
          <Markdown text={text} projectId={projectId} streaming={!done} className="text-[13px] leading-relaxed" />
        </div>
      )}

      {hasText && !expanded && !done && (
        <div
          ref={previewRef}
          className={cn(
            'relative mt-1.5 ml-[7px] max-h-[7.5rem] overflow-hidden border-l-2 border-brand/40 pl-3.5 text-muted-foreground',
            // Fade out older lines at the top once the preview overflows.
            overflowing && '[mask-image:linear-gradient(to_bottom,transparent,black_2.25rem)]',
          )}
        >
          <Markdown text={text} projectId={projectId} streaming className="text-[13px] leading-relaxed" />
        </div>
      )}
    </div>
  );
}

/**
 * Shown right after sending until the agent's first output (thought, text or tool) arrives —
 * models often think for a while before anything is streamed.
 */
export function ThinkingIndicator({ since }: { since?: number }) {
  const elapsed = useElapsed(true, since);
  return (
    <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground" role="status">
      <Brain className="size-3.5 text-brand" />
      <span className="thinking-shimmer tabular-nums">Denkt nach…{elapsed >= 1000 ? ` ${formatDuration(elapsed)}` : ''}</span>
    </div>
  );
}
