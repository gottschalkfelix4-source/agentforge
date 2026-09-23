import { AGENT_MANIFESTS, getAgentManifest, type AgentManifest, type AgentToolStatus, type TermCreateParams, type ToolVersion } from '@vibe/shared';

const LATEST_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

type Fetch = typeof fetch;

/** Latest published versions (npm registry / PyPI / GitHub releases), cached for an hour. */
export class LatestVersions {
  private cache = new Map<string, { at: number; value: Promise<string | null> }>();

  constructor(private readonly fetchImpl: Fetch = fetch, private readonly ttlMs = LATEST_TTL_MS) {}

  private cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = load().catch(() => null);
    this.cache.set(key, { at: Date.now(), value });
    // Failures are not cached for long: retry after a minute.
    void value.then((v) => {
      if (v === null) this.cache.set(key, { at: Date.now() - this.ttlMs + 60_000, value });
    });
    return value;
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'agentforge' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  npm(pkg: string) {
    // Scoped names keep their '@' but the slash must be encoded.
    return this.cached(`npm:${pkg}`, async () => {
      const j = (await this.json(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`)) as { version?: string };
      return j.version ?? null;
    });
  }

  pypi(pkg: string) {
    return this.cached(`pypi:${pkg}`, async () => {
      const j = (await this.json(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`)) as { info?: { version?: string } };
      return j.info?.version ?? null;
    });
  }

  github(repo: string) {
    return this.cached(`gh:${repo}`, async () => {
      const j = (await this.json(`https://api.github.com/repos/${repo}/releases/latest`)) as { tag_name?: string };
      return j.tag_name ? j.tag_name.replace(/^v/, '') : null;
    });
  }

  forAgent(m: AgentManifest): Promise<string | null> {
    if (m.npmPackage) return this.npm(m.npmPackage);
    if (m.pypiPackage) return this.pypi(m.pypiPackage);
    if (m.githubRepo) return this.github(m.githubRepo);
    return Promise.resolve(null);
  }
}

/** Numeric semver-ish compare; pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split(/-(.*)/s, 2) as [string, string | undefined];
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return (x.pre ?? '').localeCompare(y.pre ?? '');
}

export const isInstallable = (m: AgentManifest) => !!(m.installCommand || m.npmPackage);

export function toolStatus(m: AgentManifest, installed: string | null, latest: string | null): AgentToolStatus {
  return {
    agentId: m.id,
    label: m.label,
    bin: m.bin,
    installed,
    latest,
    updateAvailable: !!(installed && latest && compareVersions(installed, latest) < 0),
    installable: isInstallable(m),
    chat: !!m.structured,
  };
}

export async function combineStatus(versions: ToolVersion[] | null, latest: LatestVersions): Promise<AgentToolStatus[]> {
  const byId = new Map((versions ?? []).map((v) => [v.agentId, v.version]));
  return Promise.all(AGENT_MANIFESTS.map(async (m) => toolStatus(m, byId.get(m.id) ?? null, await latest.forAgent(m))));
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Terminal that installs/updates an agent into the shared /opt/vibe-tools volume
 * (NPM_CONFIG_PREFIX / UV_TOOL_DIR point there in the image), so every workspace benefits.
 */
export function installLaunch(agentId: string): TermCreateParams {
  const m = getAgentManifest(agentId);
  if (!m) throw new Error(`Unbekannter Agent: ${agentId}`);
  let cmd: string;
  if (m.installCommand) {
    cmd = m.installCommand.map(shellQuote).join(' ');
    // `bash -c <script>` is passed through verbatim.
    if (m.installCommand[0] === 'bash' && m.installCommand[1] === '-c' && m.installCommand.length === 3) cmd = m.installCommand[2]!;
  } else if (m.npmPackage) {
    const pkgs = [m.npmPackage, ...(m.extraNpmPackages ?? [])].map((p) => `${p}@latest`);
    cmd = `npm install -g --no-audit --no-fund ${pkgs.map(shellQuote).join(' ')}`;
  } else {
    throw new Error(`${m.label} kann nicht automatisch installiert werden`);
  }
  const check = m.versionArgs ? `${shellQuote(m.bin)} ${m.versionArgs.map(shellQuote).join(' ')}` : 'true';
  const script = [
    `echo "\\$ ${cmd.replace(/["\\$`]/g, '\\$&')}"`,
    `( ${cmd} )`,
    'rc=$?',
    'echo',
    `if [ $rc -eq 0 ]; then echo "✔ ${m.label} ist aktuell: $(${check} 2>&1 | head -n1)"; else echo "✘ Installation fehlgeschlagen (Exit $rc)"; fi`,
    'exit $rc',
  ].join('\n');
  return { command: 'bash', args: ['-lc', script], title: `${m.label} – Update` };
}
