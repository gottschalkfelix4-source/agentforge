import type { AgentEvent, ApprovalPolicy } from '@vibe/shared';

type ApprovalRequest = Extract<AgentEvent, { type: 'approval.request' }>;

/**
 * The option Agentforge picks by itself for a permission request under `policy`, or null when the user
 * has to decide. One-time permissions come first: "always allow" lets some agents (Claude Code) write
 * permanent rules into their settings, so it is only used when the agent offers nothing else.
 */
export function autoApproval(e: ApprovalRequest, policy: ApprovalPolicy): string | null {
  if (policy === 'ask' || (policy === 'edits' && e.kind !== 'edit')) return null;
  const option = e.options.find((o) => o.kind === 'allow_once') ?? e.options.find((o) => o.kind === 'allow_always');
  return option?.id ?? null;
}

/** Permission requests of an event log that are still open (no approval.resolved yet). */
export function openApprovals(events: AgentEvent[]): ApprovalRequest[] {
  const open = new Map<string, ApprovalRequest>();
  for (const e of events) {
    if (e.type === 'approval.request') open.set(e.id, e);
    else if (e.type === 'approval.resolved') open.delete(e.id);
  }
  return [...open.values()];
}
