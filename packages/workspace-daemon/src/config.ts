import path from 'node:path';

declare const __WSD_VERSION__: string | undefined;

export const VERSION: string = typeof __WSD_VERSION__ === 'string' ? __WSD_VERSION__ : '0.0.0-dev';

export interface WsdConfig {
  port: number;
  host: string;
  root: string;
  tokenFile: string;
  tokenEnv: string | undefined;
  initGitUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WsdConfig {
  const port = Number.parseInt(env.WSD_PORT ?? '', 10);
  return {
    port: Number.isFinite(port) && port > 0 ? port : 7777,
    host: env.WSD_HOST || '0.0.0.0',
    root: path.resolve(env.WSD_ROOT || '/workspace'),
    tokenFile: env.WSD_TOKEN_FILE || '/run/vibe/wsd-token',
    tokenEnv: env.WSD_TOKEN || undefined,
    initGitUrl: env.WSD_INIT_GIT_URL || undefined,
  };
}

/** Env vars that belong to the daemon and must not leak into user processes. */
export const PRIVATE_ENV_KEYS = ['WSD_TOKEN', 'WSD_TOKEN_FILE', 'WSD_INIT_GIT_URL'];
