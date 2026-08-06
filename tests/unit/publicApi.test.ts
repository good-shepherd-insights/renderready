import { describe, expect, it } from 'vitest';

import * as publicApi from '../../src/index.js';

/**
 * The public API surface, spelled out.
 *
 * Every name here is covered by semver: adding one is a minor release, removing
 * or renaming one is a major. That makes an accidental change to this list a bug
 * the compiler cannot catch — re-exporting an internal helper "just for now" is
 * a one-line diff that silently commits us to supporting it forever.
 *
 * So the list is asserted rather than described. If this test fails, either the
 * change was intentional (update the list, document the addition in the README,
 * and add a changeset with the right bump) or it was not (revert it).
 *
 * Type-only exports cannot be observed at runtime and so are not covered here;
 * `attw` and `publint` check that the emitted declarations resolve, and the
 * README is the record of which types are public.
 */
const PUBLIC_VALUE_EXPORTS = [
  // Entry points
  'createRenderer',
  'createServer',
  'start',
  // Configuring
  'RESOURCE_TYPES',
  // Errors
  'BrowserLaunchError',
  'BrowserUnavailableError',
  'ConfigError',
  'InvalidUrlError',
  'RenderError',
  'RenderReadyError',
  'UrlNotAllowedError',
  'isRenderReadyError',
  // Extras
  'VERSION',
] as const;

describe('public API', () => {
  it('exports exactly the documented value surface', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it('exposes the three entry points as callables', () => {
    expect(typeof publicApi.start).toBe('function');
    expect(typeof publicApi.createServer).toBe('function');
    expect(typeof publicApi.createRenderer).toBe('function');
  });

  it('exposes every error class as a RenderReadyError subclass', () => {
    const errorClasses = [
      publicApi.BrowserLaunchError,
      publicApi.BrowserUnavailableError,
      publicApi.ConfigError,
      publicApi.InvalidUrlError,
      publicApi.RenderError,
      publicApi.UrlNotAllowedError,
    ];

    for (const ErrorClass of errorClasses) {
      const error = new ErrorClass('boom');
      expect(error).toBeInstanceOf(publicApi.RenderReadyError);
      expect(error).toBeInstanceOf(Error);
      // The name is what shows up in a stack trace, so it must not be inherited.
      expect(error.name).toBe(ErrorClass.name);
      // A stable code is the whole point of the taxonomy; callers branch on it.
      expect(error.code).toMatch(/^[A-Z_]+$/);
      expect(publicApi.isRenderReadyError(error)).toBe(true);
    }
  });

  it('reports a version that looks like a version', () => {
    expect(publicApi.VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists Playwright resource types as a readonly tuple', () => {
    expect(publicApi.RESOURCE_TYPES).toContain('image');
    expect(publicApi.RESOURCE_TYPES).toContain('websocket');
    expect(Object.isFrozen(publicApi.RESOURCE_TYPES)).toBe(false); // `as const` is compile-time only
  });
});
