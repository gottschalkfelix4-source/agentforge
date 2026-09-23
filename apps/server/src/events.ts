import { EventEmitter } from 'node:events';
import type { Channel, ServerEvent } from '@vibe/shared';

/** In-process pub/sub that the control WebSocket fans out to subscribed browsers. */
class EventBus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(0);
  }

  publish(ch: Channel, e: ServerEvent) {
    this.ee.emit('event', ch, e);
  }

  /** Publishes a project-scoped event to its project channel. */
  project(projectId: string, e: ServerEvent) {
    this.publish(`project:${projectId}`, e);
  }

  subscribe(fn: (ch: Channel, e: ServerEvent) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
}

export const bus = new EventBus();
