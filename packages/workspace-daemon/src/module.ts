import type { WsdMethod, WsdMethods, WsdNotifications } from '@vibe/shared';

/** What feature modules get from the daemon. */
export interface WsdContext {
  /** Absolute workspace root (/workspace). */
  root: string;
  /** Broadcast a notification to all connected app servers. */
  notify<K extends keyof WsdNotifications>(method: K, params: WsdNotifications[K]): void;
}

export type ModuleHandlers<M extends WsdMethod> = {
  [K in M]: (params: WsdMethods[K][0]) => WsdMethods[K][1] | Promise<WsdMethods[K][1]>;
};

export const notImplemented = (method: string) => () => {
  throw Object.assign(new Error(`${method} is not implemented yet`), { code: 'ENOTIMPL' });
};
