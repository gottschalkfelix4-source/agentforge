import * as React from 'react';
import type { ModelPricing } from '@vibe/shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { contextBreakdown, type ContextPartKey } from './context-breakdown';
import { formatPerMillion, formatPricing, formatUsd } from './cost';
import type { Turn, Usage } from './transcript';
import { formatTokens } from './util';

const PART_COLOR: Record<ContextPartKey, string> = {
  user: 'bg-sky-500',
  assistant: 'bg-violet-500',
  tools: 'bg-amber-500',
  rest: 'bg-slate-400 dark:bg-slate-500',
};

const de = (n: number) => n.toLocaleString('de-DE');
const pctOf = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(n / of < 0.1 ? 1 : 0)} %` : '');

/** Session cost as shown in the header: "≈ 0,042 $" when Agentforge estimated it from the model pricing. */
export const costLabel = (u: Usage) => (u.costUsd === undefined ? null : `${u.costEstimated ? '≈ ' : ''}${formatUsd(u.costUsd)}`);

/**
 * How full the context is (ring + percent, or the token count when the window is unknown) and what the session
 * cost so far; click for the breakdown of the context window, the billed tokens and the model's price.
 */
export function ContextMeter({
  usage,
  turns,
  pricing,
  modelName,
  className,
}: {
  usage: Usage;
  turns: Turn[];
  pricing?: ModelPricing | null;
  modelName?: string | null;
  className?: string;
}) {
  const used = usage.contextUsed;
  const pct = usage.contextPercent ?? (used !== undefined && usage.contextWindow ? (used / usage.contextWindow) * 100 : undefined);
  const cost = costLabel(usage);
  if (used === undefined && pct === undefined && !cost) return null;
  const known = pct !== undefined;
  const fill = Math.min(100, Math.max(0, pct ?? 0));
  const tone = fill >= 90 ? 'text-destructive' : fill >= 75 ? 'text-warning' : 'text-muted-foreground';
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const summary = [
    used !== undefined
      ? usage.contextWindow
        ? `Kontext: ${de(used)} von ${de(usage.contextWindow)} Token belegt (${Math.round(fill)} %)`
        : `Kontext: ${de(used)} Token belegt`
      : known
        ? `Kontext zu ${Math.round(fill)} % belegt`
        : null,
    cost ? `Kosten: ${cost}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${summary} – klicken für Details`}
          aria-label={`${summary}. Details anzeigen`}
          className={cn(
            'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-mono text-[10.5px] tabular-nums transition-colors hover:bg-accent data-[state=open]:bg-accent',
            tone,
            className,
          )}
        >
          {(used !== undefined || known) && (
            <span className="flex items-center gap-1">
              <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
                <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
                {known && <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(fill / 100) * c} ${c}`} />}
              </svg>
              {known ? `${Math.round(fill)} %` : formatTokens(used!)}
            </span>
          )}
          {cost && <span className="text-muted-foreground">{cost}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-3">
        <UsageDetails usage={usage} turns={turns} pricing={pricing} modelName={modelName} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsageDetails({ usage, turns, pricing, modelName }: { usage: Usage; turns: Turn[]; pricing?: ModelPricing | null; modelName?: string | null }) {
  const used = usage.contextUsed;
  const win = usage.contextWindow;
  const breakdown = React.useMemo(() => (used !== undefined ? contextBreakdown(turns, used) : null), [turns, used]);
  const total = win && used !== undefined ? Math.max(win, used) : used;
  const spent = usage.spent;
  const cost = costLabel(usage);

  return (
    <div className="space-y-3 text-xs">
      <section>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-medium">Kontextfenster</h3>
          {used !== undefined && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {win ? `${formatTokens(used)} / ${formatTokens(win)}` : `${formatTokens(used)} belegt`}
            </span>
          )}
        </div>
        {breakdown && total ? (
          <>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Belegung des Kontextfensters">
              {breakdown.parts.map((p) =>
                p.tokens > 0 ? <div key={p.key} className={PART_COLOR[p.key]} style={{ width: `${(p.tokens / total) * 100}%` }} /> : null,
              )}
            </div>
            <ul className="mt-2 space-y-1">
              {breakdown.parts.map((p) => (
                <li key={p.key} className="flex items-center gap-2">
                  <span className={cn('size-2 shrink-0 rounded-sm', PART_COLOR[p.key])} />
                  <span className="min-w-0 flex-1">{p.label}</span>
                  <span className="font-mono tabular-nums">{de(p.tokens)}</span>
                  <span className="w-12 text-right font-mono text-muted-foreground tabular-nums">{pctOf(p.tokens, total)}</span>
                </li>
              ))}
              {!!win && (
                <li className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-sm bg-muted ring-1 ring-border" />
                  <span className="min-w-0 flex-1">Frei</span>
                  <span className="font-mono tabular-nums">{de(Math.max(0, win - used!))}</span>
                  <span className="w-12 text-right font-mono text-muted-foreground tabular-nums">{pctOf(Math.max(0, win - used!), total)}</span>
                </li>
              )}
            </ul>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              Belegt laut Agent: {de(used!)} Token{win ? ` von ${de(win)}` : ' (Kontextgröße des Modells unbekannt)'}. Die Aufteilung ist aus
              dem Verlauf geschätzt (≈ 4 Zeichen pro Token).
              {breakdown.compacted && ' Der Verlauf ist größer als der Kontext – der Agent hat ältere Teile vermutlich komprimiert.'}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            {usage.contextPercent !== undefined ? `Kontext zu ${Math.round(usage.contextPercent)} % belegt.` : 'Der Agent meldet keine Kontextbelegung.'}
          </p>
        )}
      </section>

      {(spent || usage.inputTokens !== undefined || usage.outputTokens !== undefined) && (
        <section className="border-t border-border pt-3">
          <h3 className="mb-1.5 text-[13px] font-medium">Verbrauch dieser Session</h3>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            {spent ? (
              <>
                <Row label="Eingabe" value={spent.input} />
                {spent.cachedInput > 0 && <Row label="Eingabe aus Cache" value={spent.cachedInput} />}
                {spent.cacheWrite > 0 && <Row label="In Cache geschrieben" value={spent.cacheWrite} />}
                <Row label="Ausgabe (inkl. Denken)" value={spent.output} />
              </>
            ) : (
              <>
                {usage.inputTokens !== undefined && <Row label="Eingabe" value={usage.inputTokens} />}
                {usage.outputTokens !== undefined && <Row label="Ausgabe" value={usage.outputTokens} />}
              </>
            )}
          </dl>
        </section>
      )}

      {(cost || pricing) && (
        <section className="border-t border-border pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-medium">Kosten</h3>
            {cost && <span className="font-mono text-[13px] tabular-nums">{cost}</span>}
          </div>
          {usage.costEstimated && (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">Berechnet aus den Token und den Preisen des Providers für das Modell.</p>
          )}
          {pricing && (
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {modelName ? `${modelName}: ` : ''}
              {formatPricing(pricing)} (Eingabe / Ausgabe)
              {pricing.cacheRead !== null && pricing.cacheRead !== pricing.prompt && ` · Cache-Lesen ${formatUsdPerM(pricing.cacheRead)}`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

const formatUsdPerM = (perToken: number) => `${formatPerMillion(perToken)} / 1 Mio.`;

function Row({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono tabular-nums">{de(value)}</dd>
    </>
  );
}
