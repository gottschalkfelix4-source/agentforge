import { defineConfig } from 'vitest/config';

// Only our sources: the dev data dir (.data) holds agent homes with third-party test files.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
