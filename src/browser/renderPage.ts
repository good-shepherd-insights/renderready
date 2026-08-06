import type { Page, Route } from 'playwright-core';

import type { ResourceType } from '../config.js';
import { RenderError, errorMessage } from '../errors.js';
import type { Logger } from '../logger.js';

import { trackRequests, waitForPageReady, type ReadinessOptions } from './readiness.js';

export interface RenderPageOptions {
  url: string;
  viewport: { width: number; height: number };
  /** Budget for the whole render: navigation and the readiness wait share it. */
  timeoutMs: number;
  followRedirects: boolean;
  readiness: ReadinessOptions;
  blockedResourceTypes: readonly ResourceType[];
  blockedUrlPatterns: readonly string[];
  logger: Logger;
}

interface RenderPageResult {
  html: string;
  status: number;
  /** Response headers from the origin's reply to the requested URL. */
  headers: Record<string, string>;
  /** The requested URL answered with a 3xx that we deliberately did not follow. */
  isRedirect: boolean;
  /** The readiness budget ran out; `html` is whatever had rendered by then. */
  timedOut: boolean;
}

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400;

/**
 * Drive one page: navigate, wait for readiness, return the serialized HTML.
 *
 * The page and its private context are owned by the browser manager; this
 * function only borrows them. Navigation failures are raised as `RenderError`.
 */
export async function renderPage(
  page: Page,
  options: RenderPageOptions,
): Promise<RenderPageResult> {
  const { url, logger } = options;
  const deadlineAt = Date.now() + options.timeoutMs;
  const remaining = (): number => Math.max(0, deadlineAt - Date.now());

  await page.setViewportSize(options.viewport);

  // Registered first so it sits *underneath* the document interceptor below:
  // Playwright runs the most recently registered matching handler first.
  await installResourceBlocking(page, options);

  // Populated by the interceptor during navigation when the requested URL
  // answers with a 3xx. Absent entirely when following redirects is enabled.
  const redirect = options.followRedirects
    ? undefined
    : await installRedirectDetection(page, url, logger);

  const asRedirectResult = (): RenderPageResult | undefined =>
    redirect?.status === undefined
      ? undefined
      : {
          html: '',
          status: redirect.status,
          headers: redirect.headers,
          isRedirect: true,
          timedOut: false,
        };

  const tracker = trackRequests(page);

  try {
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'commit', timeout: remaining() });
    } catch (error) {
      // Aborting the navigation is how a detected redirect stops the render, so
      // a goto failure with a captured 3xx is a success, not a failure.
      const redirected = asRedirectResult();
      if (redirected) {
        return redirected;
      }
      throw new RenderError(`Could not load ${url}: ${errorMessage(error)}`, { cause: error });
    }

    const redirected = asRedirectResult();
    if (redirected) {
      return redirected;
    }

    const rawStatus = response?.status() ?? 0;
    const headers = response ? await safeHeaders(response) : {};

    const { timedOut, usedReadyFlag } = await waitForPageReady(
      page,
      tracker,
      options.readiness,
      deadlineAt,
      logger,
    );

    const html = await page.content().catch((error: unknown) => {
      throw new RenderError(`Could not read the page content for ${url}: ${errorMessage(error)}`, {
        cause: error,
      });
    });

    logger.debug('Page captured', {
      url,
      status: rawStatus,
      timedOut,
      usedReadyFlag,
      bytes: html.length,
    });

    return {
      html,
      // A 304 means "your cache is current", but each render uses a fresh
      // context with an empty cache, so there is nothing for a caller to
      // revalidate against. Report what the body actually is.
      status: rawStatus === 304 ? 200 : rawStatus,
      headers,
      isRedirect: false,
      timedOut,
    };
  } finally {
    tracker.stop();
  }
}

interface RedirectCapture {
  status: number | undefined;
  headers: Record<string, string>;
}

/**
 * Detect a redirect on the requested URL without following it.
 *
 * Crawlers need to see the 3xx so they can update their index, so the default is
 * not to follow — but Playwright's `goto()` always does. The workaround is to
 * intercept the top-level document request and re-fetch it with `maxRedirects: 0`.
 * On a 3xx we record it and abort, so the destination is never fetched or
 * rendered; otherwise we fulfill the navigation from the response we already
 * have, avoiding a second request to the origin.
 *
 * Scoped to the exact requested URL, so subresources are untouched.
 */
async function installRedirectDetection(
  page: Page,
  url: string,
  logger: Logger,
): Promise<RedirectCapture> {
  const capture: RedirectCapture = { status: undefined, headers: {} };
  const normalized = new URL(url).href;

  await page.route(
    requestUrl => requestUrl.href === normalized,
    async (route: Route) => {
      if (route.request().resourceType() !== 'document') {
        // Same URL but not the navigation itself; let the blocking handler
        // registered underneath decide.
        return route.fallback();
      }

      let documentResponse;
      try {
        documentResponse = await route.fetch({ maxRedirects: 0 });
      } catch (error) {
        // Could not fetch it ourselves; fall back to an ordinary navigation and
        // accept that a redirect will be followed.
        logger.debug('Redirect probe failed; navigating normally', {
          url,
          error: errorMessage(error),
        });
        return route.continue();
      }

      try {
        if (isRedirectStatus(documentResponse.status())) {
          capture.status = documentResponse.status();
          capture.headers = documentResponse.headers();
          await route.abort();
          return;
        }
        await route.fulfill({ response: documentResponse });
      } finally {
        // Not optional: without this the response body is retained for the life
        // of the context, which leaks steadily under load.
        await documentResponse.dispose().catch(() => {});
      }
    },
  );

  return capture;
}

/**
 * Abort requests matching the configured resource types or URL substrings.
 *
 * Only installed when something is actually configured — an always-on `**\/*`
 * handler routes every request through Node, which is a real cost on an
 * asset-heavy page.
 */
async function installResourceBlocking(page: Page, options: RenderPageOptions): Promise<void> {
  const { blockedResourceTypes, blockedUrlPatterns } = options;
  if (blockedResourceTypes.length === 0 && blockedUrlPatterns.length === 0) {
    return;
  }

  const types = new Set<string>(blockedResourceTypes);

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const blocked =
      types.has(request.resourceType()) ||
      blockedUrlPatterns.some(pattern => request.url().includes(pattern));

    if (blocked) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}

/** Response headers, tolerating a response that has already gone away. */
async function safeHeaders(response: {
  allHeaders: () => Promise<Record<string, string>>;
}): Promise<Record<string, string>> {
  try {
    return await response.allHeaders();
  } catch {
    return {};
  }
}
