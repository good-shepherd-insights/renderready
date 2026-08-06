import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  platform: 'node',
  // Keep the dependency graph external; this is a library, not a bundle.
  external: ['playwright-core', 'fastify', 'zod'],
});
