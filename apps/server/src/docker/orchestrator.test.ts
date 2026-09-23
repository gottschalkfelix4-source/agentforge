import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { Orchestrator } from './orchestrator.js';

const dir = mkdtempSync(path.join(tmpdir(), 'agentforge-orch-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ensureAgentDefaults (Claude settings)', () => {
  const orch = new Orchestrator({ ...config, dataDir: dir });
  const file = path.join(dir, 'agent-home', 'claude', 'settings.json');

  it('merges thinking summaries and the agentforge allow rule into existing settings', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] } }));
    orch.ensureAgentDefaults();
    const s = JSON.parse(readFileSync(file, 'utf8'));
    expect(s).toMatchObject({
      theme: 'dark',
      showThinkingSummaries: true,
      permissions: { allow: ['Bash(ls:*)', 'mcp__agentforge'], deny: ['Bash(rm:*)'] },
    });
  });

  it('is idempotent and respects an explicit user choice', () => {
    writeFileSync(file, JSON.stringify({ showThinkingSummaries: false, permissions: { allow: ['mcp__agentforge'] } }));
    const before = readFileSync(file, 'utf8');
    orch.ensureAgentDefaults();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('leaves unparsable settings untouched', () => {
    writeFileSync(file, '{ not json');
    orch.ensureAgentDefaults();
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });
});
