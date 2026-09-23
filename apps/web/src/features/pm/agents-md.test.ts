import { describe, expect, it } from 'vitest';
import {
  AGENTFORGE_SECTION_END,
  AGENTFORGE_SECTION_START,
  agentforgeSection,
  agentsMdTemplate,
  claudeMdTemplate,
  upsertAgentforgeSection,
} from '@vibe/shared';

describe('AGENTS.md templates', () => {
  it('contains the Agentforge section with all board tools', () => {
    const t = agentsMdTemplate('Shop');
    expect(t.startsWith('# Shop')).toBe(true);
    for (const tool of ['project_overview', 'task_set_status', 'milestone_create', 'note_update']) expect(t).toContain(tool);
    expect(t).toContain('playwright');
    expect(claudeMdTemplate('Shop')).toMatch(/^@AGENTS\.md$/m);
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
});
