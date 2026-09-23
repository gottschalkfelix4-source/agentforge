// Fractional indexing for kanban ranks (base-62 keys, compared as plain strings).
// Keys never end with the smallest digit, so there is always room between two keys.

export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rank: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

export function isValidRank(r: string): boolean {
  return r.length > 0 && !r.endsWith(ZERO) && [...r].every((c) => DIGITS.includes(c));
}

/** A key strictly between `a` and `b` (null = open end). */
export function rankBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`rank: ${a} >= ${b}`);
  return midpoint(a ?? '', b);
}

/** `n` evenly growing keys (used to rebalance a column). */
export function rankSequence(n: number): string[] {
  const out: string[] = [];
  let last: string | null = null;
  for (let i = 0; i < n; i++) {
    last = rankBetween(last, null);
    out.push(last);
  }
  return out;
}

export interface Ranked {
  id: string;
  rank: string;
}

export interface MovePlan {
  rank: string;
  /** Set when the column had to be renumbered (duplicate / invalid ranks); ids → new ranks, incl. the moved task. */
  rebalance?: Map<string, string>;
}

/**
 * Rank for `movingId` placed into a column (ranks of the target column, any order).
 * `beforeId` = the task that will be directly above, `afterId` = directly below. `beforeId` wins
 * when both are given but no longer adjacent (stale client state); unknown ids fall back to the end.
 */
export function planMove(column: Ranked[], movingId: string, beforeId?: string | null, afterId?: string | null): MovePlan {
  const others = column.filter((t) => t.id !== movingId).sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : x.id < y.id ? -1 : 1));
  let idx = others.length; // insertion index
  const bi = beforeId ? others.findIndex((t) => t.id === beforeId) : -1;
  const ai = afterId ? others.findIndex((t) => t.id === afterId) : -1;
  if (bi >= 0) idx = bi + 1;
  else if (ai >= 0) idx = ai;
  const prev = others[idx - 1]?.rank ?? null;
  const next = others[idx]?.rank ?? null;
  const ok = (prev === null || isValidRank(prev)) && (next === null || isValidRank(next)) && (prev === null || next === null || prev < next);
  if (ok) return { rank: rankBetween(prev, next) };
  const ids = others.map((t) => t.id);
  ids.splice(idx, 0, movingId);
  const seq = rankSequence(ids.length);
  const rebalance = new Map(ids.map((id, i) => [id, seq[i]!]));
  return { rank: rebalance.get(movingId)!, rebalance };
}

/** Rank after the current last task of a column. */
export function rankAtEnd(column: Ranked[]): string {
  const valid = column.map((t) => t.rank).filter(isValidRank).sort();
  return rankBetween(valid.at(-1) ?? null, null);
}
