// Minimal line diff (Myers) + unified-diff parsing for the inline diff renderer.
import type { FileDiff } from '@vibe/shared';

export type DiffLineKind = 'ctx' | 'add' | 'del' | 'hunk';
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_D = 2000;

function splitLines(s: string | null): string[] {
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Edit script between a and b: list of ops ('=', '-', '+') with indices. */
function myers(a: string[], b: string[]): { op: '=' | '-' | '+'; ai: number; bi: number }[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return null;
  // backtrack
  const ops: { op: '=' | '-' | '+'; ai: number; bi: number }[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1]! < vv[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: '=', ai: x, bi: y });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: '+', ai: x, bi: prevY });
      else ops.push({ op: '-', ai: prevX, bi: y });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Diff two texts into display lines with `context` lines around changes. */
export function diffTexts(oldText: string | null, newText: string | null, context = 3): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let ops = a.length + b.length > 20_000 ? null : myers(a, b);
  if (!ops) {
    ops = [
      ...a.map((_, i) => ({ op: '-' as const, ai: i, bi: 0 })),
      ...b.map((_, i) => ({ op: '+' as const, ai: 0, bi: i })),
    ];
  }
  const full: DiffLine[] = ops.map((o) =>
    o.op === '='
      ? { kind: 'ctx', text: a[o.ai]!, oldNo: o.ai + 1, newNo: o.bi + 1 }
      : o.op === '-'
        ? { kind: 'del', text: a[o.ai]!, oldNo: o.ai + 1 }
        : { kind: 'add', text: b[o.bi]!, newNo: o.bi + 1 },
  );
  // collapse unchanged regions
  const keep = new Uint8Array(full.length);
  full.forEach((l, i) => {
    if (l.kind !== 'ctx') for (let j = Math.max(0, i - context); j <= Math.min(full.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  full.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'hunk', text: `… ${skipped} unveränderte Zeilen` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: 'hunk', text: `… ${skipped} unveränderte Zeilen` });
  return out;
}

/** Parse a unified diff into display lines. */
export function parseUnified(unified: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of unified.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      out.push({ kind: 'hunk', text: raw });
    } else if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ });
    else if (raw.startsWith('\\')) continue;
    else if (raw.length || out.length) out.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  while (out.length && out[out.length - 1]!.kind === 'ctx' && out[out.length - 1]!.text === '') out.pop();
  return out;
}

export function fileDiffLines(f: FileDiff): DiffLine[] {
  if (f.unified && f.oldText == null && f.newText == null) return parseUnified(f.unified);
  return diffTexts(f.oldText, f.newText);
}

export function diffStats(f: FileDiff): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of fileDiffLines(f)) {
    if (l.kind === 'add') add++;
    else if (l.kind === 'del') del++;
  }
  return { add, del };
}
