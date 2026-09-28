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

describe('ensureAgentDefaults (Gemini/Qwen context files)', () => {
  const orch = new Orchestrator({ ...config, dataDir: dir });

  it('makes Gemini and Qwen read AGENTS.md next to their own file', () => {
    orch.ensureAgentDefaults();
    expect(JSON.parse(readFileSync(path.join(dir, 'agent-home', 'gemini', 'settings.json'), 'utf8'))).toEqual({
      context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
    });
    expect(JSON.parse(readFileSync(path.join(dir, 'agent-home', 'qwen', 'settings.json'), 'utf8'))).toEqual({
      context: { fileName: ['AGENTS.md', 'QWEN.md'] },
    });
  });

  it('keeps a user-configured context file name', () => {
    const file = path.join(dir, 'agent-home', 'gemini', 'settings.json');
    writeFileSync(file, JSON.stringify({ context: { fileName: 'MY.md' }, theme: 'x' }));
    const before = readFileSync(file, 'utf8');
    orch.ensureAgentDefaults();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('createContainer', () => {
  const spec = { workspaceId: 'w1', projectId: 'P1', image: 'img', cpuLimit: null, memLimitMb: null, gitUrl: null, projectName: null };

  function fakeDocker(existing: { Id: string; Config: { Labels: Record<string, string> } } | null) {
    const calls: string[] = [];
    let held = existing;
    const docker = {
      createContainer: async (opts: { name: string }) => {
        calls.push(`create ${opts.name}`);
        if (held) throw Object.assign(new Error('Conflict. The container name is already in use'), { statusCode: 409 });
        return { id: 'new-id' };
      },
      getContainer: (id: string) => ({
        inspect: async () => {
          if (!held) throw Object.assign(new Error('no such container'), { statusCode: 404 });
          return { ...held, State: { Running: true } };
        },
        remove: async () => {
          calls.push(`remove ${id}`);
          held = null;
        },
      }),
    };
    return { docker, calls };
  }

  it('replaces an orphaned container of the same project that holds the name', async () => {
    const orch = new Orchestrator({ ...config, dataDir: dir });
    const { docker, calls } = fakeDocker({ Id: 'stale', Config: { Labels: { 'vibe.managed': 'true', 'vibe.project': 'P1' } } });
    (orch as unknown as { docker: unknown }).docker = docker;
    expect(await orch.createContainer(spec)).toBe('new-id');
    expect(calls).toEqual(['create agentforge-ws-p1', 'remove stale', 'create agentforge-ws-p1']);
  });

  it('never touches a foreign container with that name', async () => {
    const orch = new Orchestrator({ ...config, dataDir: dir });
    const { docker, calls } = fakeDocker({ Id: 'other', Config: { Labels: {} } });
    (orch as unknown as { docker: unknown }).docker = docker;
    await expect(orch.createContainer(spec)).rejects.toThrow('already in use');
    expect(calls).toEqual(['create agentforge-ws-p1']);
  });
});
