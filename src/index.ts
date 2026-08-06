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
 */

export { createServer, start } from './server/createServer.js';
export type { RenderReadyServer, ServerOptions } from './server/createServer.js';
export { renderRequestSchema } from './server/schema.js';
export type { RenderRequest } from './server/schema.js';

export { createRenderer } from './render/renderer.js';
export type { Renderer, RendererOptions, RenderOptions, RenderResult } from './render/renderer.js';

export { resolveConfig, RESOURCE_TYPES, DEFAULT_ORIGIN_HEADERS } from './config.js';
export type {
  AccessConfig,
  BrowserConfig,
  Env,
  RenderConfig,
  RenderReadyConfig,
  RenderReadyOptions,
  ResourceType,
  ServerConfig,
} from './config.js';

export type { Hooks, RenderedContext, RenderFinishedInfo, RenderRequestContext } from './hooks.js';

export { createConsoleLogger, noopLogger, isLogLevel, LOG_LEVELS } from './logger.js';
export type { LogLevel, LogMeta, Logger } from './logger.js';

export {
  BrowserLaunchError,
  BrowserUnavailableError,
  ConfigError,
  errorMessage,
  InvalidUrlError,
  isRenderReadyError,
  RenderError,
  RenderReadyError,
  UrlNotAllowedError,
} from './errors.js';
export type { RenderReadyErrorCode } from './errors.js';

// The HTML transforms are exported because they are pure and useful on their own —
// for post-processing HTML you obtained some other way, or inside an onPageLoaded hook.
export {
  absolutizeUrls,
  applyHtmlTransforms,
  decodeHtmlEntities,
  extractMetaDirectives,
  injectRenderMeta,
  removeScriptTags,
} from './render/htmlTransforms.js';
export type {
  HtmlTransformOptions,
  HtmlTransformResult,
  MetaDirectives,
} from './render/htmlTransforms.js';

export { assertDomainAllowed, hostnameMatches, normalizeUrl } from './render/url.js';

export type { AvailabilityHooks, BrowserManager, BrowserStats } from './browser/browserManager.js';

export { VERSION } from './version.js';
