import type { ModuleHandlers, WsdContext } from '../module.js';
import { AgentHost, type Starter } from './host.js';

// Phase 2 – hosts structured agent processes (ACP / Codex app-server) via @vibe/agent-adapters.
export type AgentMethod =
  | 'agent.start' | 'agent.prompt' | 'agent.cancel' | 'agent.respond' | 'agent.setMode'
  | 'agent.setModel' | 'agent.stop' | 'agent.list' | 'agent.events';

export function createAgentModule(
  ctx: WsdContext,
  starter?: Starter,
): { handlers: ModuleHandlers<AgentMethod>; host: AgentHost; close(): Promise<void> } {
  const host = new AgentHost(ctx.root, (m, p) => ctx.notify(m, p), starter);
  return {
    host,
    handlers: {
      'agent.start': (p) => host.start(p),
      'agent.prompt': (p) => host.prompt(p),
      'agent.cancel': (p) => host.cancel(p),
      'agent.respond': (p) => host.respond(p),
      'agent.setMode': (p) => host.setMode(p),
      'agent.setModel': (p) => host.setModel(p),
      'agent.stop': (p) => host.stop(p),
      'agent.list': () => host.list(),
      'agent.events': (p) => host.events(p),
    },
    close: () => host.close(),
  };
}
