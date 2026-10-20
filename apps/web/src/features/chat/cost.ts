import type { ModelPricing } from '@vibe/shared';

const usd = (digits: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "0,0042 $", "0,123 $", "12,34 $" — enough digits that small turns don't read as zero. */
export function formatUsd(n: number): string {
  if (n === 0) return usd(2).format(0);
  const a = Math.abs(n);
  return usd(a < 0.01 ? 4 : a < 1 ? 3 : 2).format(n);
}

/** USD per million tokens from a per-token price ("3 $", "0,15 $"). */
export function formatPerMillion(perToken: number): string {
  const m = perToken * 1_000_000;
  if (m === 0) return 'kostenlos';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD', maximumFractionDigits: m < 1 ? 3 : 2 }).format(m);
}

/** "3 $ / 15 $ pro 1 Mio. Token" (input / output). */
export function formatPricing(p: ModelPricing): string {
  if (p.prompt === 0 && p.completion === 0) return 'kostenlos';
  return `${formatPerMillion(p.prompt)} / ${formatPerMillion(p.completion)} pro 1 Mio. Token`;
}
