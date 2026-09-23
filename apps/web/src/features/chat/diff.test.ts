import { describe, expect, it } from 'vitest';
import { diffStats, diffTexts, parseUnified } from './diff';

describe('diff', () => {
  it('diffs texts with context', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const b = ['1', '2', '3', '4', 'X', '6', '7', '8', '9', '10', '11'].join('\n');
    const lines = diffTexts(a, b, 1);
    const changed = lines.filter((l) => l.kind === 'add' || l.kind === 'del').map((l) => `${l.kind}:${l.text}`);
    expect(changed).toEqual(['del:5', 'add:X', 'add:11']);
    expect(lines.some((l) => l.kind === 'hunk')).toBe(true);
  });

  it('handles new and deleted files', () => {
    expect(diffStats({ path: 'a', oldText: null, newText: 'a\nb\n' })).toEqual({ add: 2, del: 0 });
    expect(diffStats({ path: 'a', oldText: 'a\n', newText: null })).toEqual({ add: 0, del: 1 });
  });

  it('parses unified diffs', () => {
    const lines = parseUnified('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'ctx', 'del', 'add']);
    expect(lines[3]!.newNo).toBe(2);
  });
});
