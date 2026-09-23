import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { AGENT_MANIFESTS, WSD_PORT } from '@vibe/shared';
import type { Config } from '../config.js';

export const MANAGED_LABEL = 'vibe.managed';

export interface WorkspaceSpec {
  workspaceId: string;
  projectId: string;
  image: string;
  cpuLimit: number | null;
  memLimitMb: number | null;
  gitUrl: string | null;
  projectName: string | null;
}

export interface WsdEndpoint {
  host: string;
  port: number;
}

/**
 * Creates and controls workspace containers. Only ever touches containers carrying the
 * `vibe.managed=true` label, and only builds them from the fixed, hardened template below.
 */
export class Orchestrator {
  readonly docker: Docker;

  constructor(private readonly cfg: Config) {
    this.docker = new Docker();
  }

  async ping(): Promise<{ ok: boolean; error: string | null }> {
    try {
      await this.docker.ping();
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async imagePresent(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /** Pulls the image if missing. Local-only tags (no registry) can't be pulled and must be built. */
  async ensureImage(image: string, onProgress: (msg: string) => void) {
    if (await this.imagePresent(image)) return;
    onProgress(`Lade Image ${image} …`);
    const stream = await this.docker.pull(image).catch((err: Error) => {
      throw new Error(
        `Workspace-Image "${image}" fehlt und konnte nicht geladen werden (${err.message}). ` +
          `Lokal bauen mit: docker build -f docker/workspace/Dockerfile -t ${image} .`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      let last = 0;
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (ev: { status?: string; progress?: string; id?: string }) => {
          if (Date.now() - last < 500) return;
          last = Date.now();
          onProgress([ev.id, ev.status, ev.progress].filter(Boolean).join(' '));
        },
      );
    });
  }

  async ensureNetwork() {
    const nets = await this.docker.listNetworks({ filters: { name: [this.cfg.networkName] } });
    if (!nets.some((n) => n.Name === this.cfg.networkName)) {
      await this.docker.createNetwork({
        Name: this.cfg.networkName,
        Driver: 'bridge',
        Labels: { [MANAGED_LABEL]: 'true' },
      });
    }
    // When the app runs in a container, it must join the network to reach workspaces by name.
    if (this.cfg.inContainer) {
      const self = this.docker.getContainer(hostname());
      const info = await self.inspect().catch(() => null);
      if (info && !info.NetworkSettings.Networks[this.cfg.networkName]) {
        await this.docker.getNetwork(this.cfg.networkName).connect({ Container: info.Id });
      }
    }
  }

  containerName(projectId: string) {
    return `agentforge-ws-${projectId.toLowerCase()}`;
  }

  /** Local path (in the app's view) of a directory under the data dir. */
  localPath(...segments: string[]) {
    return path.join(this.cfg.dataDir, ...segments);
  }

  /** Same directory as seen by the Docker host, for bind mounts. */
  hostPath(...segments: string[]) {
    const base = this.cfg.hostDataPath;
    return base.startsWith('/') ? path.posix.join(base, ...segments) : path.win32.join(base, ...segments);
  }

  /** Writes the wsd auth token where the container will read it (mounted read-only at /run/vibe). */
  writeWsdToken(workspaceId: string, token: string) {
    const dir = this.localPath('generated', workspaceId);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'wsd-token');
    writeFileSync(file, token, { mode: 0o644 });
    chmodSync(file, 0o644);
  }

  async createContainer(spec: WorkspaceSpec): Promise<string> {
    const binds: { local: string[]; target: string; readOnly?: boolean }[] = [
      { local: ['projects', spec.projectId], target: '/workspace' },
      { local: ['generated', spec.workspaceId], target: '/run/vibe', readOnly: true },
      { local: ['tools'], target: '/opt/vibe-tools' },
      { local: ['cache', 'npm'], target: '/home/coder/.npm' },
      { local: ['cache', 'pnpm'], target: '/home/coder/.local/share/pnpm' },
      { local: ['cache', 'pip'], target: '/home/coder/.cache/pip' },
    ];
    const baseEnv: Record<string, string> = {};
    for (const agent of AGENT_MANIFESTS) {
      for (const dir of agent.homeDirs) binds.push({ local: ['agent-home', dir.name], target: dir.containerPath });
      Object.assign(baseEnv, agent.baseEnv);
    }
    // Create host directories ourselves; otherwise dockerd creates them owned by root.
    for (const b of binds) mkdirSync(this.localPath(...b.local), { recursive: true });

    const env = [
      'WSD_TOKEN_FILE=/run/vibe/wsd-token',
      ...Object.entries(baseEnv).map(([k, v]) => `${k}=${v}`),
    ];
    if (this.cfg.puid) env.push(`PUID=${this.cfg.puid}`);
    if (this.cfg.pgid) env.push(`PGID=${this.cfg.pgid}`);
    if (this.cfg.tz) env.push(`TZ=${this.cfg.tz}`);
    if (spec.gitUrl) env.push(`WSD_INIT_GIT_URL=${spec.gitUrl}`);
    if (spec.projectName) env.push(`VIBE_PROJECT=${spec.projectName}`);
    // Docker Desktop on Windows: bind mounts deliver no inotify events, so dev-server watchers must poll.
    if (!this.cfg.hostDataPath.startsWith('/')) env.push('CHOKIDAR_USEPOLLING=true', 'WATCHPACK_POLLING=true');

    const portKey = `${WSD_PORT}/tcp`;
    const container = await this.docker.createContainer({
      name: this.containerName(spec.projectId),
      Image: spec.image,
      Hostname: `ws-${spec.projectId.slice(-8).toLowerCase()}`,
      Env: env,
      Labels: {
        [MANAGED_LABEL]: 'true',
        'vibe.project': spec.projectId,
        'vibe.workspace': spec.workspaceId,
      },
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        Mounts: binds.map((b) => ({
          Type: 'bind' as const,
          Source: this.hostPath(...b.local),
          Target: b.target,
          ReadOnly: b.readOnly ?? false,
        })),
        NetworkMode: this.cfg.networkName,
        PortBindings: this.cfg.publishWsd ? { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '' }] } : undefined,
        ExtraHosts: ['host.docker.internal:host-gateway'],
        RestartPolicy: { Name: 'unless-stopped' },
        Privileged: false,
        CapDrop: ['ALL'],
        // Needed by the entrypoint (uid remap, chown, gosu) and by normal dev tooling.
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'NET_BIND_SERVICE'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: 4096,
        NanoCpus: spec.cpuLimit ? Math.round(spec.cpuLimit * 1e9) : undefined,
        Memory: spec.memLimitMb ? spec.memLimitMb * 1024 * 1024 : undefined,
        Init: false, // the image runs tini itself
      },
    });
    return container.id;
  }

  private async managed(containerId: string) {
    const c = this.docker.getContainer(containerId);
    const info = await c.inspect();
    if (info.Config.Labels?.[MANAGED_LABEL] !== 'true') throw new Error('Container wird nicht von Agentforge verwaltet');
    return { c, info };
  }

  async inspect(containerId: string) {
    try {
      return (await this.managed(containerId)).info;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async start(containerId: string) {
    const { c, info } = await this.managed(containerId);
    if (!info.State.Running) await c.start();
  }

  async stop(containerId: string) {
    const { c, info } = await this.managed(containerId);
    if (info.State.Running) await c.stop({ t: 10 });
  }

  async remove(containerId: string) {
    try {
      const { c } = await this.managed(containerId);
      await c.remove({ force: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  /** Where the app can reach the container's wsd. */
  async wsdEndpoint(containerId: string): Promise<WsdEndpoint> {
    const info = await this.inspect(containerId);
    if (!info) throw new Error('Container existiert nicht');
    if (this.cfg.publishWsd) {
      const binding = info.NetworkSettings.Ports?.[`${WSD_PORT}/tcp`]?.[0];
      if (!binding) throw new Error('wsd-Port ist nicht veröffentlicht');
      return { host: '127.0.0.1', port: Number(binding.HostPort) };
    }
    return { host: info.Name.replace(/^\//, ''), port: WSD_PORT };
  }
}
