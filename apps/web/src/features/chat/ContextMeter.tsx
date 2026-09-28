import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Usage } from './transcript';
import { formatTokens } from './util';

/** How full the context is: ring + percent (or the token count when the window is unknown), details on hover. */
export function ContextMeter({ usage, className }: { usage: Usage; className?: string }) {
  const used = usage.contextUsed;
  const pct = usage.contextPercent;
  if (used === undefined && pct === undefined) return null;
  const known = pct !== undefined;
  const fill = Math.min(100, Math.max(0, pct ?? 0));
  const tone = fill >= 90 ? 'text-destructive' : fill >= 75 ? 'text-warning' : 'text-muted-foreground';
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const details =
    used !== undefined
      ? usage.contextWindow
        ? `Kontext: ${used.toLocaleString('de-DE')} von ${usage.contextWindow.toLocaleString('de-DE')} Token belegt (${Math.round(fill)} %)`
        : `Kontext: ${used.toLocaleString('de-DE')} Token belegt (Kontextgröße des Modells unbekannt)`
      : `Kontext zu ${Math.round(fill)} % belegt`;
  return (
    <Tooltip content={details}>
      <span
        className={cn('flex shrink-0 items-center gap-1 font-mono text-[10.5px] tabular-nums', tone, className)}
        aria-label={details}
        role="img"
      >
        <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
          <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
          {known && <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(fill / 100) * c} ${c}`} />}
        </svg>
        {known ? `${Math.round(fill)} %` : formatTokens(used!)}
      </span>
    </Tooltip>
  );
}
