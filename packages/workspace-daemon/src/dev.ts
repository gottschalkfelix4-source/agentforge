// Local development entry (`pnpm dev`): sets dev defaults, then starts the daemon.
// Override with WSD_ROOT / WSD_TOKEN / WSD_PORT env vars.
import fs from 'node:fs';
import path from 'node:path';

process.env.WSD_ROOT ||= path.resolve('.dev-workspace');
process.env.WSD_TOKEN ||= 'dev';
process.env.WSD_TOKEN_FILE ||= path.resolve('.dev-workspace-token-unused');
process.env.WSD_HOST ||= '127.0.0.1';
fs.mkdirSync(process.env.WSD_ROOT, { recursive: true });
console.log(`[wsd] dev mode: root=${process.env.WSD_ROOT} token=${process.env.WSD_TOKEN}`);

await import('./index.js');
