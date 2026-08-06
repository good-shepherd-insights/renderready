/**
 * renderready — prerender any JavaScript web page to static HTML.
 *
 * Three entry points, smallest first:
 *
 * ```ts
 * import { start } from 'renderready';
 * const server = await start();               // listens on PORT (default 3000)
 * ```
 *
 * ```ts
 * import { createServer } from 'renderready';
 * const server = createServer({ port: 3000 });
 * await server.listen();
 * server.fastify.get('/custom', handler);     // escape hatch
 * ```
 *
 * ```ts
 * import { createRenderer } from 'renderready';
 * const renderer = createRenderer();
 * await renderer.start();
 * const { html, statusCode } = await renderer.render('https://example.com');
 * await renderer.stop();
 * ```
 *
 * Everything exported here is public API covered by semver, and everything
 * exported here is documented in the README. Internals stay internal even where
 * re-exporting them would be convenient: an export nobody documents is the worst
 * of both worlds — locked by semver, and undiscoverable. Adding to this list is a
 * minor release; removing from it is a major one, so it stays deliberately short.
 */

// ---------------------------------------------------------------- entry points

export { createServer, start } from './server/createServer.js';
export type { RenderReadyServer, ServerOptions } from './server/createServer.js';

export { createRenderer } from './render/renderer.js';
export type { Renderer, RendererOptions, RenderOptions, RenderResult } from './render/renderer.js';

// ------------------------------------------------------------------ configuring

/** Every option accepted by the three entry points, all optional. */
export type { RenderReadyOptions } from './config.js';

/**
 * The resolved, fully-populated configuration, reachable via `renderer.config`.
 * Its grouped sub-shapes are intentionally not exported by name — read them
 * through this type.
 */
export type { RenderReadyConfig } from './config.js';

/** Playwright's resource types, for `blockedResourceTypes`. */
export { RESOURCE_TYPES } from './config.js';
export type { ResourceType } from './config.js';

/** The request shape accepted by `POST /render`, for typing your own callers. */
export type { RenderRequest } from './server/schema.js';

// ------------------------------------------------------------------- extending

export type { Hooks, RenderedContext, RenderFinishedInfo, RenderRequestContext } from './hooks.js';

/** Implement this to route our logs into your own logger. */
export type { LogLevel, LogMeta, Logger } from './logger.js';

/** Wire these to a readiness probe; passed via `RendererOptions.availability`. */
export type { AvailabilityHooks, BrowserStats } from './browser/browserManager.js';

// -------------------------------------------------------------- handling errors

export {
  BrowserLaunchError,
  BrowserUnavailableError,
  ConfigError,
  InvalidUrlError,
  isRenderReadyError,
  RenderError,
  RenderReadyError,
  UrlNotAllowedError,
} from './errors.js';
export type { RenderReadyErrorCode } from './errors.js';

// ----------------------------------------------------------------------- extras

export { VERSION } from './version.js';
