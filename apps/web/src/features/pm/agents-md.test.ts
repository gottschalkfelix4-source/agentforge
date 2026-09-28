import { describe, expect, it } from 'vitest';
import {
  AGENTFORGE_SECTION_END,
  AGENTFORGE_SECTION_START,
  agentforgeSection,
  agentInstructionUpdates,
  agentsMdTemplate,
  claudeMdTemplate,
  upsertAgentforgeSection,
  withAgentsMdImport,
} from '@vibe/shared';

describe('AGENTS.md templates', () => {
  it('contains the Agentforge section with all board tools', () => {
    const t = agentsMdTemplate('Shop');
    expect(t.startsWith('# Shop')).toBe(true);
    for (const tool of ['project_overview', 'task_set_status', 'milestone_create', 'note_update']) expect(t).toContain(tool);
    expect(t).toContain('playwright');
    // The user cannot change task status in the UI — the template must make the agent own it.
    expect(t).toContain('Status pflegst ausschließlich du');
    expect(t).toContain('Nur du öffnest und schließt sie');
    expect(claudeMdTemplate('Shop')).toMatch(/^@AGENTS\.md$/m);
    // Rules that keep (small) models working until the task is done.
    expect(t).toContain('Arbeite, bis die Aufgabe fertig ist');
    expect(t).toContain('Handeln statt ankündigen');
  });

  it('appends the section to existing files without touching own content', () => {
    const own = '# Mein Projekt\n\nEigene Regeln.\n';
    const out = upsertAgentforgeSection(own);
    expect(out.startsWith(own.trimEnd())).toBe(true);
    expect(out).toContain(AGENTFORGE_SECTION_START);
  });

  it('replaces an outdated section in place and is idempotent', () => {
    const file = `# X\n\nvorher\n\n${AGENTFORGE_SECTION_START}\nALT\n${AGENTFORGE_SECTION_END}\n\nnachher\n`;
    const out = upsertAgentforgeSection(file);
    expect(out).not.toContain('ALT');
    expect(out).toContain('vorher');
    expect(out).toContain('nachher');
    expect(out.split(AGENTFORGE_SECTION_START)).toHaveLength(2);
    expect(upsertAgentforgeSection(out)).toBe(out);
    expect(out).toContain(agentforgeSection());
  });

  it('imports AGENTS.md into an existing CLAUDE.md once', () => {
    const out = withAgentsMdImport('# X\n\nEigenes.\n');
    expect(out).toBe('# X\n\n@AGENTS.md\n\nEigenes.\n');
    expect(withAgentsMdImport(out)).toBe(out);
  });

  it('plans the workspace files: create missing, refresh outdated, skip current', () => {
    expect(agentInstructionUpdates({ agentsMd: null, claudeMd: null }, 'Shop')).toEqual([
      { path: 'AGENTS.md', content: agentsMdTemplate('Shop') },
      { path: 'CLAUDE.md', content: claudeMdTemplate('Shop') },
    ]);
    const old = `# Shop\n\n${AGENTFORGE_SECTION_START}\nALT\n${AGENTFORGE_SECTION_END}\n`;
    const updates = agentInstructionUpdates({ agentsMd: old, claudeMd: claudeMdTemplate('Shop') }, 'Shop');
    expect(updates.map((u) => u.path)).toEqual(['AGENTS.md']);
    expect(updates[0]!.content).toContain(agentforgeSection());
    expect(agentInstructionUpdates({ agentsMd: updates[0]!.content, claudeMd: claudeMdTemplate('Shop') }, 'Shop')).toEqual([]);
  });
});
