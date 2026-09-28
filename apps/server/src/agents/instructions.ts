// Keeps the agent instructions (AGENTS.md with the Agentforge section, CLAUDE.md importing it) in the workspace
// root current, so every agent knows its environment from the first start — no manual step in the Notes tab.

import { agentInstructionUpdates } from '@vibe/shared';
import type { Db } from '../db/index.js';
import type { WsdClient } from '../workspaces/wsd-client.js';

/** Creates missing files and refreshes the Agentforge section. Never throws: an agent must start anyway. */
export async function ensureAgentInstructions(db: Db, projectId: string, client: WsdClient, warn: (msg: string) => void): Promise<void> {
  try {
    const project = db.get<{ name: string; git_url: string | null; repo_owner: string | null }>(
      'SELECT name, git_url, repo_owner FROM projects WHERE id = ?',
      projectId,
    );
    if (!project) return;
    const entries = await client.call('fs.list', { path: '.' });
    const names = new Set(entries.map((e) => e.name));
    // A repo that is still being cloned needs an empty directory; the next agent start writes the files.
    if ((project.git_url || project.repo_owner) && !names.has('.git')) return;
    const read = async (name: string) => (names.has(name) ? (await client.call('fs.read', { path: name })).content : null);
    const updates = agentInstructionUpdates({ agentsMd: await read('AGENTS.md'), claudeMd: await read('CLAUDE.md') }, project.name);
    for (const u of updates) await client.call('fs.write', { path: u.path, content: u.content });
  } catch (err) {
    warn(`AGENTS.md/CLAUDE.md für ${projectId}: ${(err as Error).message}`);
  }
}
