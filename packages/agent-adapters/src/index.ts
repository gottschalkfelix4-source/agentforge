import type { StructuredTransport } from '@vibe/shared';
import { AcpAdapter } from './acp.js';
import { CodexAppServerAdapter } from './codex.js';
import type { AgentAdapter, AgentSessionHandle, AgentStartOptions } from './types.js';

export * from './types.js';
export { AcpAdapter, AcpSession } from './acp.js';
export { CodexAppServerAdapter, CodexSession, CODEX_MODES, codexMcpArgs, splitUnifiedDiff } from './codex.js';
export { JsonRpcProcess, RpcError } from './jsonrpc.js';

export const ADAPTERS: Record<StructuredTransport, AgentAdapter> = {
  acp: AcpAdapter,
  codex_app_server: CodexAppServerAdapter,
};

/** Spawns a structured agent session for the given transport. */
export function startAgent(transport: StructuredTransport, opts: AgentStartOptions): AgentSessionHandle {
  const adapter = ADAPTERS[transport];
  if (!adapter) throw new Error(`Unbekannter Transport: ${transport}`);
  return adapter.start(opts);
}
