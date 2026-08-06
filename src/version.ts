/**
 * The package version, inlined at build time by tsup's `define`.
 *
 * Reading package.json at runtime is awkward for a package that ships both ESM
 * and CJS: `import.meta.url` does not exist in the CJS output and `__dirname`
 * does not exist in the ESM output. A build-time constant sidesteps both.
 *
 * The `typeof` guard is what makes this work under tsx and Vitest, where no
 * replacement happens and the identifier is genuinely undefined.
 */
declare const __RENDERREADY_VERSION__: string;

export const VERSION: string =
  typeof __RENDERREADY_VERSION__ === 'string' ? __RENDERREADY_VERSION__ : '0.0.0-dev';
