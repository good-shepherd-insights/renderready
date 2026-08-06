import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

// Inlined so the package never has to locate its own package.json at runtime,
// which differs between the ESM and CJS outputs.
const define = { __RENDERREADY_VERSION__: JSON.stringify(version) };

const shared = {
  target: 'node20',
  platform: 'node' as const,
  sourcemap: true,
  define,
  // This is a library, not a bundle: leave the dependency graph external.
  external: ['playwright-core', 'fastify', 'zod'],
};

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    // Only the first config cleans, or it would delete the other's output.
    clean: true,
  },
  {
    ...shared,
    entry: ['src/cli.ts'],
    // ESM only. `bin` points at the ESM build, and a second copy of the CLI in
    // CommonJS would be dead weight that nothing resolves.
    format: ['esm'],
    dts: false,
    clean: false,
  },
]);
