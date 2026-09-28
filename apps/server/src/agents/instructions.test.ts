import { agentsMdTemplate, claudeMdTemplate } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import type { WsdClient } from '../workspaces/wsd-client.js';
import { ensureAgentInstructions } from './instructions.js';

function setup(project: { name: string; git_url?: string | null; repo_owner?: string | null } | null, files: Record<string, string>) {
  const db = { get: () => (project ? { git_url: null, repo_owner: null, ...project } : undefined) } as unknown as Db;
  const writes: string[] = [];
  const client = {
    call: async (method: string, p: { path: string; content?: string }) => {
      if (method === 'fs.list') return Object.keys(files).map((name) => ({ name, type: 'file' }));
      if (method === 'fs.read') return { path: p.path, content: files[p.path], encoding: 'utf8', size: 0 };
      if (method === 'fs.write') {
        writes.push(p.path);
        files[p.path] = p.content!;
        return { ok: true };
      }
      throw new Error(method);
    },
  } as unknown as WsdClient;
  const warnings: string[] = [];
  return { db, client, files, writes, warnings, warn: (m: string) => warnings.push(m) };
}

describe('ensureAgentInstructions', () => {
  it('creates AGENTS.md and CLAUDE.md in a new workspace', async () => {
    const s = setup({ name: 'Shop' }, {});
    await ensureAgentInstructions(s.db, 'P', s.client, s.warn);
    expect(s.files['AGENTS.md']).toBe(agentsMdTemplate('Shop'));
    expect(s.files['CLAUDE.md']).toBe(claudeMdTemplate('Shop'));
  });

  it('adds the section to an existing AGENTS.md and writes nothing once current', async () => {
    const s = setup({ name: 'Shop' }, { 'AGENTS.md': '# Eigenes\n', 'CLAUDE.md': claudeMdTemplate('Shop') });
    await ensureAgentInstructions(s.db, 'P', s.client, s.warn);
    expect(s.writes).toEqual(['AGENTS.md']);
    expect(s.files['AGENTS.md']!.startsWith('# Eigenes\n')).toBe(true);
    s.writes.length = 0;
    await ensureAgentInstructions(s.db, 'P', s.client, s.warn);
    expect(s.writes).toEqual([]);
  });

  it('leaves a repo that is still being cloned alone', async () => {
    const s = setup({ name: 'Shop', repo_owner: 'me' }, {});
    await ensureAgentInstructions(s.db, 'P', s.client, s.warn);
    expect(s.writes).toEqual([]);
  });

  it('only warns when the workspace fails', async () => {
    const s = setup({ name: 'Shop' }, {});
    const broken = { call: async () => Promise.reject(new Error('offline')) } as unknown as WsdClient;
    await ensureAgentInstructions(s.db, 'P', broken, s.warn);
    expect(s.warnings[0]).toContain('offline');
  });
});
