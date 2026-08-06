import { randomUUID } from 'node:crypto';

import type { BrowserContextOptions } from 'playwright-core';

import {
  createBrowserManager,
  type AvailabilityHooks,
  type BrowserManager,
  type BrowserStats,
} from '../browser/browserManager.js';
import { renderPage } from '../browser/renderPage.js';
import { resolveConfig, type RenderReadyConfig, type RenderReadyOptions } from '../config.js';
import type { BrowserLaunchError } from '../errors.js';
import { errorMessage } from '../errors.js';
import type { Hooks, RenderedContext, RenderRequestContext } from '../hooks.js';
import { createConsoleLogger, type Logger } from '../logger.js';

import { applyHtmlTransforms } from './htmlTransforms.js';
import { assertDomainAllowed, normalizeUrl } from './url.js';

/** Per-request overrides. Anything omitted falls back to the resolved config. */
export interface RenderOptions {
  width?: number;
  height?: number;
  userAgent?: string;
  followRedirects?: boolean;
  /** Override the render budget in ms. */
  timeout?: number;
}

export interface RenderResult {
  url: string;
  renderId: string;
  html: string;
  statusCode: number;
  /** Response headers from the origin, merged with any requested via meta tags. */
  headers: Record<string, string>;
  isRedirect: boolean;
  /** The budget ran out; `html` is whatever had rendered by then. */
  timedOut: boolean;
  durationMs: number;
}

export interface RendererOptions extends RenderReadyOptions {
  hooks?: Hooks;
  availability?: AvailabilityHooks;
  onFatal?: (error: BrowserLaunchError) => void;
}

export interface Renderer {
  /** Launch the browser. Rejects with `BrowserLaunchError` if Chromium is unusable. */
  start(): Promise<void>;
  stop(): Promise<void>;
  render(url: string, options?: RenderOptions): Promise<RenderResult>;
  isReady(): boolean;
  stats(): BrowserStats;
  readonly config: RenderReadyConfig;
  readonly logger: Logger;
}

/**
 * The rendering core, with no HTTP layer attached.
 *
 * Use this directly when you want prerendered HTML inside an existing process —
 * a build step, a worker, your own framework's routes — rather than a server.
 * `createServer` is a thin wrapper around it.
 */
export function createRenderer(options: RendererOptions = {}): Renderer {
  const config = resolveConfig(options);
  const logger = options.logger ?? createConsoleLogger(config.logLevel);
  const hooks = options.hooks ?? {};

  const browser: BrowserManager = createBrowserManager({
    config: config.browser,
    logger,
    ...(options.availability ? { availability: options.availability } : {}),
    ...(options.onFatal ? { onFatal: options.onFatal } : {}),
  });

  async function render(rawUrl: string, renderOptions: RenderOptions = {}): Promise<RenderResult> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const renderId = randomUUID();

    // Validation before anything expensive: a bad URL should never cost a page.
    const url = normalizeUrl(rawUrl);
    assertDomainAllowed(url, config.access);

    const requestContext: RenderRequestContext = { url, renderId, startedAt };

    try {
      await hooks.onRequest?.(requestContext);

      const viewport = {
        width: renderOptions.width ?? config.render.viewportWidth,
        height: renderOptions.height ?? config.render.viewportHeight,
      };
      const userAgent = renderOptions.userAgent ?? config.render.userAgent;

      const contextOptions: BrowserContextOptions = {
        viewport,
        ...(userAgent !== null && userAgent !== undefined ? { userAgent } : {}),
        ...(Object.keys(config.render.originHeaders).length > 0
          ? { extraHTTPHeaders: config.render.originHeaders }
          : {}),
      };

      logger.debug('Rendering', { url, renderId });

      const page = await browser.withPage(async browserPage => {
        await hooks.onPageCreated?.(browserPage, requestContext);
        return renderPage(browserPage, {
          url,
          viewport,
          timeoutMs: renderOptions.timeout ?? config.render.pageLoadTimeout,
          followRedirects: renderOptions.followRedirects ?? config.render.followRedirects,
          readiness: {
            pageDoneCheckInterval: config.render.pageDoneCheckInterval,
            waitAfterLastRequest: config.render.waitAfterLastRequest,
            renderReadyDelay: config.render.renderReadyDelay,
          },
          blockedResourceTypes: config.render.blockedResourceTypes,
          blockedUrlPatterns: config.render.blockedUrlPatterns,
          logger,
        });
      }, contextOptions);

      // A redirect we chose not to follow has no body to transform: the 3xx and
      // its Location header are the entire answer.
      const transformed = page.isRedirect
        ? { html: '', statusCode: undefined, headers: {} }
        : applyHtmlTransforms(
            page.html,
            url,
            {
              removeScriptTags: config.render.removeScriptTags,
              absoluteUrls: config.render.absoluteUrls,
              metaStatusCode: config.render.metaStatusCode,
              injectRenderMeta: config.render.injectRenderMeta,
            },
            { renderId, renderedAt: startedAt },
          );

      const rendered: RenderedContext = {
        ...requestContext,
        html: transformed.html,
        statusCode: resolveStatusCode(page, transformed.statusCode, config),
        headers: { ...page.headers, ...transformed.headers },
        isRedirect: page.isRedirect,
        timedOut: page.timedOut,
      };

      await hooks.onPageLoaded?.(rendered);

      const result: RenderResult = {
        url,
        renderId,
        html: rendered.html,
        statusCode: rendered.statusCode,
        headers: rendered.headers,
        isRedirect: rendered.isRedirect,
        timedOut: rendered.timedOut,
        durationMs: Date.now() - startedMs,
      };

      logger.info('Rendered', {
        url,
        status: result.statusCode,
        ms: result.durationMs,
        timedOut: result.timedOut || undefined,
      });

      await reportFinished({
        ...requestContext,
        durationMs: result.durationMs,
        statusCode: result.statusCode,
        isRedirect: result.isRedirect,
        timedOut: result.timedOut,
      });

      return result;
    } catch (error) {
      await reportFinished({
        ...requestContext,
        durationMs: Date.now() - startedMs,
        error,
      });
      throw error;
    }
  }

  /** Observability must never be the reason a render fails. */
  async function reportFinished(
    info: Parameters<NonNullable<Hooks['onRenderFinished']>>[0],
  ): Promise<void> {
    try {
      await hooks.onRenderFinished?.(info);
    } catch (error) {
      logger.warn('onRenderFinished threw; ignoring', { error: errorMessage(error) });
    }
  }

  return {
    start: () => browser.start(),
    stop: () => browser.stop(),
    render,
    isReady: () => browser.isReady(),
    stats: () => browser.stats(),
    config,
    logger,
  };
}

/**
 * Decide the status code to report, in increasing order of specificity:
 *
 * 1. What the origin returned.
 * 2. `renderErrorStatusCode`, if there was no response at all.
 * 3. `timeoutStatusCode`, if the render timed out and one is configured.
 * 4. `<meta name="renderready-status-code">`, if the page declared one — the app
 *    knows more about its own routing than we do, so it wins.
 */
function resolveStatusCode(
  page: { status: number; isRedirect: boolean; timedOut: boolean },
  metaStatusCode: number | undefined,
  config: RenderReadyConfig,
): number {
  if (page.isRedirect) {
    return page.status;
  }

  let status = page.status === 0 ? config.render.renderErrorStatusCode : page.status;

  if (page.timedOut && config.render.timeoutStatusCode !== null) {
    status = config.render.timeoutStatusCode;
  }

  if (metaStatusCode !== undefined) {
    status = metaStatusCode;
  }

  return status;
}
