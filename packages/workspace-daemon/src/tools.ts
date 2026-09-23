import { execFile } from 'node:child_process';
import { AGENT_MANIFESTS, type ToolVersion } from '@vibe/shared';
import { PRIVATE_ENV_KEYS } from './config.js';
import type { ModuleHandlers, WsdContext } from './module.js';

// 5 s is plenty on Linux hosts; Python CLIs in /opt/vibe-tools on a Docker-Desktop bind mount (Windows/macOS)
// need ~5.5 s just to import, so allow 10 s (probes run in parallel).
const VERSION_TIMEOUT_MS = 10_000;

/** First semver-looking token of a `--version` output, else the first non-empty line. */
export function parseVersion(output: string): string | null {
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  if (m) return m[1]!.replace(/\.$/, '');
  const line = output.split('\n').map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 60) : null;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PRIVATE_ENV_KEYS.includes(k)) env[k] = v;
  // Keep version probes quiet and offline-ish.
  env.NO_COLOR = '1';
  env.CI = '1';
  return env;
}

function runVersion(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: VERSION_TIMEOUT_MS, env: childEnv(), maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      // Some CLIs exit non-zero on --version but still print it; a missing binary has no output.
      if (err && !String(stdout ?? '').trim()) return resolve(null);
      resolve(parseVersion(out));
    });
  });
}

// Phase 6 – installed agent CLI versions (`<bin> <versionArgs>` for each manifest, in parallel).
export function createToolsModule(_ctx: WsdContext): { handlers: ModuleHandlers<'tools.versions'> } {
  return {
    handlers: {
      'tools.versions': async (): Promise<ToolVersion[]> =>
        Promise.all(
          AGENT_MANIFESTS.map(async (m) => ({
            agentId: m.id,
            bin: m.bin,
            version: m.versionArgs ? await runVersion(m.bin, m.versionArgs) : null,
          })),
        ),
    },
  };
}
