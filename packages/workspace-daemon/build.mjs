// Bundles the daemon into a single ESM file (dist/wsd.js). node-pty is a native
// addon and stays external; it must be installed next to the bundle at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/wsd.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // ws optionally requires bufferutil/utf-8-validate (not needed).
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  define: { __WSD_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "import { createRequire as __wsdCreateRequire } from 'node:module'; const require = __wsdCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
