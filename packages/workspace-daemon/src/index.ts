import fs from 'node:fs';
import { VERSION, loadConfig } from './config.js';
import { WsdServer } from './server.js';

const cfg = loadConfig();
const server = new WsdServer(cfg);

function workspaceIsEmpty(root: string): boolean {
  try {
    return fs.readdirSync(root).filter((n) => n !== 'lost+found').length === 0;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  await server.listen();
  console.log(`[wsd] v${VERSION} listening on ${cfg.host}:${cfg.port}, root ${cfg.root}`);

  if (cfg.initGitUrl && workspaceIsEmpty(cfg.root)) {
    console.log(`[wsd] cloning ${cfg.initGitUrl} into ${cfg.root}`);
    try {
      server.terminals.create({
        command: 'git',
        args: ['clone', '--progress', cfg.initGitUrl, '.'],
        title: 'git clone',
        env: { GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (err) {
      console.error('[wsd] git clone failed to start:', err);
    }
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[wsd] ${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => console.error('[wsd] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[wsd] unhandled rejection:', err));

main().catch((err) => {
  console.error('[wsd] failed to start:', err);
  process.exit(1);
});
