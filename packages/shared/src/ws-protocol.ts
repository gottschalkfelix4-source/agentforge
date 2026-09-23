// Protocol between the browser and the app server.
//
// Control socket: `/ws` — JSON envelopes below.
// Terminal socket: `/ws/term/:projectId/:termId` — transparently bridged to wsd
//   (binary = PTY bytes, text = TermControl JSON).

import type { AgentEvent } from './agent-events.js';
import type { WorkspaceStatus } from './models.js';
import type { AgentSession } from './sessions.js';
import type { ListeningPort, WsdNotifications } from './wsd-protocol.js';

export type Channel = `project:${string}` | `session:${string}` | 'projects';

export type ClientMessage =
  | { t: 'sub'; ch: Channel }
  | { t: 'unsub'; ch: Channel }
  | { t: 'pong' };

export type ServerEvent =
  | { type: 'workspace.status'; projectId: string; status: WorkspaceStatus; message: string | null }
  | { type: 'workspace.pull'; projectId: string; progress: string }
  | { type: 'term.exit'; projectId: string; payload: WsdNotifications['term.exit'] }
  | { type: 'term.created'; projectId: string; termId: string }
  | { type: 'fs.changed'; projectId: string; paths: string[] }
  | { type: 'ports.changed'; projectId: string; ports: ListeningPort[] }
  | { type: 'projects.changed' }
  // Phase 2 — on channel session:<id>
  | { type: 'session.event'; sessionId: string; seq: number; ts: string; event: AgentEvent }
  // Phase 2 — on channel project:<id>
  | { type: 'session.updated'; projectId: string; session: AgentSession }
  | { type: 'session.deleted'; projectId: string; sessionId: string }
  // Phase 3/5 — something changed, refetch
  | { type: 'git.changed'; projectId: string }
  | { type: 'github.changed'; projectId: string }
  | { type: 'pm.changed'; projectId: string; entity: 'task' | 'milestone' | 'label' | 'note' | 'run' }
  // Phase 4
  | { type: 'previews.changed'; projectId: string };

export type ServerMessage =
  | { t: 'ev'; ch: Channel; e: ServerEvent }
  | { t: 'ping' };
