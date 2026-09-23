// Agent manifests. Adding an agent = adding an entry here (later: agents/*.json).
// Agents without `structured` are terminal-only (TUI in the agent menu); the others also power chat sessions.

import type { ProviderKind } from './models.js';

export type AgentTransport = 'acp' | 'codex_app_server' | 'pty';

export interface AgentManifest {
  id: string;
  label: string;
  /** Binary name on PATH inside the workspace image. */
  bin: string;
  /** Args to start the interactive TUI. */
  ptyArgs: string[];
  /** How to start the structured (machine) interface, if any. */
  structured?: { transport: Exclude<AgentTransport, 'pty'>; command: string; args: string[] };
  /** Command shown/run for subscription login. */
  loginCommand?: string[];
  /** Directory under agent-home persisted across workspaces, mounted at the given container path. */
  homeDirs: { name: string; containerPath: string }[];
  /** Env set for every launch (e.g. pointing the CLI at its config dir). */
  baseEnv: Record<string, string>;
  /** Provider kinds usable in "provider" auth mode. */
  providerKinds: ProviderKind[];
  /** Flag used to select a model, e.g. ['--model']. */
  modelFlag?: string;
  /** npm package providing the CLI (installed/updated into /opt/vibe-tools by the UI). */
  npmPackage?: string;
  /** Extra npm packages needed for the structured interface (e.g. an ACP adapter). */
  extraNpmPackages?: string[];
  /** Args printing the version, e.g. ['--version']. */
  versionArgs?: string[];
  /** Install/update command for agents not distributed via npm (run in a workspace terminal, lands in /opt/vibe-tools). */
  installCommand?: string[];
  /** PyPI package (latest-version lookup for non-npm agents). */
  pypiPackage?: string;
  /** GitHub repo `owner/name` whose latest release is the latest version (non-npm agents). */
  githubRepo?: string;
}

/** Installed vs. latest version of one agent CLI (GET /api/projects/:id/tools). */
export interface AgentToolStatus {
  agentId: string;
  label: string;
  bin: string;
  /** Installed version in the queried workspace (null = not found / not runnable). */
  installed: string | null;
  /** Latest published version (npm / PyPI / GitHub), null if unknown. */
  latest: string | null;
  updateAvailable: boolean;
  /** An install/update command exists for this agent. */
  installable: boolean;
  /** Supports structured chat sessions (otherwise terminal only). */
  chat: boolean;
}

/** Result of POST /api/providers/:id/test and POST /api/providers/test. */
export interface ProviderTestResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

const GOOSE_TARBALL = 'https://github.com/block/goose/releases/latest/download/goose-$(uname -m)-unknown-linux-gnu.tar.bz2';

export const AGENT_MANIFESTS: AgentManifest[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    ptyArgs: [],
    structured: { transport: 'acp', command: 'claude-agent-acp', args: [] },
    // The TUI starts its login flow on first run; `/login` switches accounts later.
    loginCommand: ['claude'],
    homeDirs: [{ name: 'claude', containerPath: '/home/coder/.claude' }],
    baseEnv: { CLAUDE_CONFIG_DIR: '/home/coder/.claude' },
    providerKinds: ['anthropic', 'anthropic_compat', 'openrouter', 'ollama'],
    modelFlag: '--model',
    npmPackage: '@anthropic-ai/claude-code',
    extraNpmPackages: ['@agentclientprotocol/claude-agent-acp'],
    versionArgs: ['--version'],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    bin: 'codex',
    ptyArgs: [],
    structured: { transport: 'codex_app_server', command: 'codex', args: ['app-server'] },
    loginCommand: ['codex', 'login', '--device-auth'],
    homeDirs: [{ name: 'codex', containerPath: '/home/coder/.codex' }],
    baseEnv: { CODEX_HOME: '/home/coder/.codex' },
    providerKinds: ['openai', 'openai_compat', 'openrouter', 'ollama'],
    modelFlag: '--model',
    npmPackage: '@openai/codex',
    versionArgs: ['--version'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    ptyArgs: [],
    structured: { transport: 'acp', command: 'opencode', args: ['acp'] },
    loginCommand: ['opencode', 'auth', 'login'],
    homeDirs: [
      { name: 'opencode-data', containerPath: '/home/coder/.local/share/opencode' },
      { name: 'opencode-config', containerPath: '/home/coder/.config/opencode' },
    ],
    baseEnv: {},
    providerKinds: ['anthropic', 'openai', 'openrouter', 'openai_compat', 'anthropic_compat', 'ollama', 'gemini'],
    modelFlag: '--model',
    npmPackage: 'opencode-ai',
    versionArgs: ['--version'],
  },
  {
    id: 'cline',
    label: 'Cline',
    bin: 'cline',
    ptyArgs: [],
    structured: { transport: 'acp', command: 'cline', args: ['--acp'] },
    loginCommand: ['cline', 'auth'],
    homeDirs: [{ name: 'cline', containerPath: '/home/coder/.cline' }],
    baseEnv: {},
    providerKinds: ['anthropic', 'openai', 'openrouter', 'openai_compat', 'anthropic_compat', 'ollama', 'gemini'],
    modelFlag: '--model',
    npmPackage: 'cline',
    versionArgs: ['--version'],
  },
  {
    id: 'kilo',
    label: 'Kilo Code',
    bin: 'kilo',
    ptyArgs: [],
    structured: { transport: 'acp', command: 'kilo', args: ['acp'] },
    loginCommand: ['kilo', 'auth', 'login'],
    homeDirs: [
      { name: 'kilo-data', containerPath: '/home/coder/.local/share/kilo' },
      { name: 'kilo-config', containerPath: '/home/coder/.config/kilo' },
    ],
    baseEnv: {},
    providerKinds: ['anthropic', 'openai', 'openrouter', 'openai_compat', 'anthropic_compat', 'ollama', 'gemini'],
    modelFlag: '--model',
    npmPackage: '@kilocode/cli',
    versionArgs: ['--version'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    ptyArgs: [],
    structured: { transport: 'acp', command: 'gemini', args: ['--experimental-acp'] },
    // The TUI shows its auth dialog on first run (Google login or API key).
    loginCommand: ['gemini'],
    homeDirs: [{ name: 'gemini', containerPath: '/home/coder/.gemini' }],
    baseEnv: {},
    providerKinds: ['gemini'],
    modelFlag: '--model',
    npmPackage: '@google/gemini-cli',
    versionArgs: ['--version'],
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    ptyArgs: [],
    structured: { transport: 'acp', command: 'qwen', args: ['--acp'] },
    // `qwen auth` was removed; the TUI's /auth dialog handles login.
    loginCommand: ['qwen'],
    homeDirs: [{ name: 'qwen', containerPath: '/home/coder/.qwen' }],
    baseEnv: {},
    providerKinds: ['openai', 'openai_compat', 'openrouter', 'ollama', 'anthropic', 'anthropic_compat', 'gemini'],
    modelFlag: '--model',
    npmPackage: '@qwen-code/qwen-code',
    versionArgs: ['--version'],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    ptyArgs: [],
    structured: { transport: 'acp', command: 'copilot', args: ['--acp'] },
    loginCommand: ['copilot', 'login'],
    homeDirs: [{ name: 'copilot', containerPath: '/home/coder/.copilot' }],
    // Updates are managed by Agentforge (/opt/vibe-tools), not by the CLI's self-updater.
    baseEnv: { COPILOT_AUTO_UPDATE: 'false' },
    providerKinds: ['openai', 'openai_compat', 'openrouter', 'ollama', 'anthropic', 'anthropic_compat'],
    modelFlag: '--model',
    npmPackage: '@github/copilot',
    versionArgs: ['--version'],
  },
  {
    id: 'goose',
    label: 'Goose',
    bin: 'goose',
    ptyArgs: ['session'],
    structured: { transport: 'acp', command: 'goose', args: ['acp'] },
    loginCommand: ['goose', 'configure'],
    homeDirs: [
      { name: 'goose-config', containerPath: '/home/coder/.config/goose' },
      { name: 'goose-data', containerPath: '/home/coder/.local/share/goose' },
    ],
    // No keyring daemon in the container: secrets from `goose configure` go to its config dir.
    baseEnv: { GOOSE_DISABLE_KEYRING: '1' },
    providerKinds: ['anthropic', 'anthropic_compat', 'openai', 'openai_compat', 'openrouter', 'ollama', 'gemini'],
    versionArgs: ['--version'],
    installCommand: ['bash', '-c', `set -euo pipefail; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; curl -fsSL "${GOOSE_TARBALL}" | tar -xj -C "$T"; install -m 755 "$(find "$T" -type f -name goose | head -n1)" /opt/vibe-tools/bin/goose; goose --version`],
    githubRepo: 'block/goose',
  },
  {
    id: 'aider',
    label: 'Aider',
    bin: 'aider',
    ptyArgs: [],
    homeDirs: [],
    baseEnv: {},
    providerKinds: ['anthropic', 'anthropic_compat', 'openai', 'openai_compat', 'openrouter', 'ollama', 'gemini'],
    modelFlag: '--model',
    versionArgs: ['--version'],
    // UV_TOOL_DIR / UV_TOOL_BIN_DIR point into /opt/vibe-tools (image env).
    installCommand: ['uv', 'tool', 'install', '--force', '--python', '/usr/bin/python3', 'aider-chat@latest'],
    pypiPackage: 'aider-chat',
  },
];

export function getAgentManifest(id: string): AgentManifest | undefined {
  return AGENT_MANIFESTS.find((a) => a.id === id);
}
