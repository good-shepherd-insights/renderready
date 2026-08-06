import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Invariants of the published manifest.
 *
 * These are the mistakes that only surface *after* publishing, because nothing
 * in the normal loop catches them: the compiler never reads package.json, unit
 * tests import from `src`, and `publint`/`attw` inspect the module graph rather
 * than the `bin` field.
 *
 * Concretely, this file exists because `bin` was `"./dist/cli.js"` and npm
 * silently dropped the entry on publish — "script name dist/cli.js was invalid
 * and removed" — which would have shipped a package whose `npx renderready`
 * did not exist. `exports` requires the `./` prefix and `bin` forbids it, which
 * is exactly the kind of asymmetry worth pinning down in a test.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, unknown>;
  main: string;
  module: string;
  types: string;
  publishConfig?: { access?: string };
  engines: { node: string };
  dependencies: Record<string, string>;
};

describe('package manifest', () => {
  describe('bin', () => {
    // npm validates bin targets and removes anything it considers unsafe,
    // including a leading "./". It warns rather than failing, so a publish
    // succeeds with the CLI quietly missing.
    it.each(Object.entries(manifest.bin))('%s target has no leading "./"', (_name, target) => {
      expect(target.startsWith('./')).toBe(false);
      expect(target.startsWith('/')).toBe(false);
    });

    it('exposes exactly the documented command', () => {
      expect(Object.keys(manifest.bin)).toEqual(['renderready']);
    });

    it('points at a path that `files` actually ships', () => {
      for (const target of Object.values(manifest.bin)) {
        const root = target.split('/')[0];
        expect(manifest.files).toContain(root);
      }
    });
  });

  describe('exports', () => {
    // The inverse rule: subpath keys and their targets must be "./"-prefixed or
    // Node refuses to resolve them.
    it('uses "./"-prefixed subpath keys', () => {
      for (const key of Object.keys(manifest.exports)) {
        expect(key === '.' || key.startsWith('./')).toBe(true);
      }
    });

    it.each(['main', 'module', 'types'] as const)('%s is "./"-prefixed', field => {
      expect(manifest[field].startsWith('./')).toBe(true);
    });
  });

  describe('publishing', () => {
    // Scoped or not, npm defaults new packages to restricted; without this the
    // first publish fails on a paid-plan error rather than anything informative.
    it('is marked public', () => {
      expect(manifest.publishConfig?.access).toBe('public');
    });

    it('ships only build output and documents, never sources or tests', () => {
      expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    });

    it('declares an engines range matching the build target', () => {
      expect(manifest.engines.node).toMatch(/^>=22/);
    });
  });

  describe('dependencies', () => {
    // Every runtime dependency is install weight for every consumer, so the list
    // is asserted rather than left to drift.
    it('has exactly the two intended runtime dependencies', () => {
      expect(Object.keys(manifest.dependencies).sort()).toEqual(['fastify', 'playwright-core']);
    });
  });
});
