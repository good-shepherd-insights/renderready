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
 * Everything exported here is public API covered by semver. Internals are
 * deliberately not re-exported, even where they would be convenient — each
 * export is a shape that cannot change without a major release.
 */

// ---------------------------------------------------------------- entry points

export { createServer, start } from './server/createServer.js';
export type { RenderReadyServer, ServerOptions } from './server/createServer.js';

export { createRenderer } from './render/renderer.js';
export type { Renderer, RendererOptions, RenderOptions, RenderResult } from './render/renderer.js';

// ------------------------------------------------------------------ configuring

export { RESOURCE_TYPES } from './config.js';
export type {
  RenderReadyOptions,
  ResourceType,
  // Reachable through `renderer.config`, so the shape needs names.
  RenderReadyConfig,
  AccessConfig,
  BrowserConfig,
  RenderConfig,
  ServerConfig,
} from './config.js';

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

/**
 * The HTML transforms, exported because they are pure and independently useful:
 * for post-processing inside an `onPageLoaded` hook, or on HTML you obtained
 * some other way entirely.
 */
export {
  absolutizeUrls,
  applyHtmlTransforms,
  extractMetaDirectives,
  removeScriptTags,
} from './render/htmlTransforms.js';
export type {
  HtmlTransformOptions,
  HtmlTransformResult,
  MetaDirectives,
} from './render/htmlTransforms.js';

/** Validate and canonicalize a URL the same way `render()` does, before calling it. */
export { normalizeUrl } from './render/url.js';

export { VERSION } from './version.js';
