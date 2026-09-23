import { existsSync } from 'node:fs';
import path from 'node:path';

const env = process.env;

// User-facing settings are documented as AGENTFORGE_*; internally they are read as VIBE_*.
for (const [key, value] of Object.entries(env)) {
  if (key.startsWith('AGENTFORGE_') && value !== undefined) {
    const internal = `VIBE_${key.slice('AGENTFORGE_'.length)}`;
    env[internal] ??= value;
  }
}

/** True when the app itself runs inside a container (then it reaches workspaces via the docker network). */
const inContainer = existsSync('/.dockerenv') || env.VIBE_IN_CONTAINER === '1';

const dataDir = path.resolve(env.VIBE_DATA_DIR ?? path.join(process.cwd(), '.data'));

export const config = {
  version: env.VIBE_VERSION ?? '0.1.0-dev',
  // Container/production default 8080; host dev default 8787 (8080 is often taken on dev machines).
  port: Number(env.PORT ?? (inContainer ? 8080 : 8787)),
  host: env.HOST ?? '0.0.0.0',
  dataDir,
  /**
   * Path of `dataDir` as seen by the Docker host. Workspace bind mounts are created by the
   * host daemon, so they need host paths. Equal to dataDir when the app runs directly on the host.
   */
  hostDataPath: env.HOST_DATA_PATH ?? dataDir,
  webDist: env.VIBE_WEB_DIST ?? null,
  workspaceImage: env.WORKSPACE_IMAGE ?? 'agentforge-workspace:dev',
  networkName: env.VIBE_NETWORK ?? 'agentforge-net',
  inContainer,
  /**
   * Publish each workspace's wsd port on 127.0.0.1 and connect through it. Needed when the app
   * runs on the host (dev on Docker Desktop), because the host can't resolve container names.
   */
  publishWsd: env.VIBE_PUBLISH_WSD ? env.VIBE_PUBLISH_WSD === '1' : !inContainer,
  puid: env.PUID ?? null,
  pgid: env.PGID ?? null,
  tz: env.TZ ?? null,
  secretKey: env.VIBE_SECRET_KEY ?? null,
  /** Extra origins allowed for WebSocket upgrades (comma separated), e.g. the Vite dev server. */
  allowedOrigins: (env.VIBE_ALLOWED_ORIGINS ?? 'http://localhost:5180').split(',').map((s) => s.trim()).filter(Boolean),
  defaultCpuLimit: env.WORKSPACE_CPUS ? Number(env.WORKSPACE_CPUS) : 4,
  defaultMemLimitMb: env.WORKSPACE_MEMORY_MB ? Number(env.WORKSPACE_MEMORY_MB) : 8192,
  secureCookies: env.VIBE_SECURE_COOKIES === '1',
  /** Live preview routing: "port" (default, no DNS needed) or "subdomain" (needs wildcard DNS). */
  previewMode: (env.PREVIEW_MODE === 'subdomain' ? 'subdomain' : 'port') as 'port' | 'subdomain',
  previewDomain: env.PREVIEW_DOMAIN ?? null,
  previewPortStart: Number(env.PREVIEW_PORT_START ?? 7100),
  previewPortCount: Number(env.PREVIEW_PORT_COUNT ?? 20),
  /** OAuth App client id for the GitHub device flow (a public value; can be overridden). */
  githubClientId: env.GITHUB_CLIENT_ID ?? null,
};

export type Config = typeof config;
