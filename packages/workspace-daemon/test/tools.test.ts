import { describe, expect, it } from 'vitest';
import { AGENT_MANIFESTS } from '@vibe/shared';
import { createToolsModule, parseVersion } from '../src/tools.js';

describe('parseVersion', () => {
  it('extracts versions from real CLI outputs', () => {
    expect(parseVersion('2.1.280 (Claude Code)')).toBe('2.1.280');
    expect(parseVersion('codex-cli 0.156.1')).toBe('0.156.1');
    expect(parseVersion('GitHub Copilot CLI 1.0.88.\nRun \'copilot update\' to check for updates.')).toBe('1.0.88');
    expect(parseVersion(' 1.52.0')).toBe('1.52.0');
    expect(parseVersion('aider 0.86.2')).toBe('0.86.2');
    expect(parseVersion('v0.24.4-preview.1')).toBe('0.24.4-preview.1');
    expect(parseVersion('')).toBeNull();
  });
});

describe('tools.versions', () => {
  it('returns one entry per manifest, null for missing binaries', async () => {
    const { handlers } = createToolsModule({ root: '.', notify: () => {} });
    const list = await handlers['tools.versions']({});
    expect(list.map((t) => t.agentId)).toEqual(AGENT_MANIFESTS.map((m) => m.id));
    for (const t of list) expect(t.version === null || typeof t.version === 'string').toBe(true);
  }, 30_000);
});
