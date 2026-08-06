import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { renderPage, type RenderPageOptions } from '../../src/browser/renderPage.js';
import { RenderError } from '../../src/errors.js';
import { noopLogger } from '../../src/logger.js';

interface RouteHandlerEntry {
  matcher: string | ((url: URL) => boolean);
  handler: (route: FakeRoute) => unknown;
}

class FakeApiResponse {
  disposed = false;
  private readonly statusCode: number;
  private readonly responseHeaders: Record<string, string>;

  constructor(statusCode: number, responseHeaders: Record<string, string> = {}) {
    this.statusCode = statusCode;
    this.responseHeaders = responseHeaders;
  }

  status = () => this.statusCode;
  headers = () => this.responseHeaders;
  dispose = vi.fn(async () => {
    this.disposed = true;
  });
}

class FakeRoute {
  fulfilled = false;
  aborted = false;
  continued = false;
  fellBack = false;
  fetchError: Error | undefined;
  private readonly requestUrl: string;
  private readonly resourceType: string;
  private readonly fetchResponse: FakeApiResponse | undefined;

  constructor(requestUrl: string, resourceType: string, fetchResponse?: FakeApiResponse) {
    this.requestUrl = requestUrl;
    this.resourceType = resourceType;
    this.fetchResponse = fetchResponse;
  }

  request = () => ({
    resourceType: () => this.resourceType,
    url: () => this.requestUrl,
  });

  fetch = vi.fn(async (): Promise<FakeApiResponse> => {
    if (this.fetchError) {
      throw this.fetchError;
    }
    if (!this.fetchResponse) {
      throw new Error('no fetch response configured');
    }
    return this.fetchResponse;
  });

  fulfill = vi.fn(async () => {
    this.fulfilled = true;
  });

  abort = vi.fn(async () => {
    this.aborted = true;
  });

  continue = vi.fn(async () => {
    this.continued = true;
  });

  fallback = vi.fn(() => {
    this.fellBack = true;
  });
}

/**
 * A page whose `goto` drives the registered route handler, the way a real
 * navigation would. That is what lets these tests exercise redirect detection
 * without a browser.
 */
class FakePage {
  readonly routes: RouteHandlerEntry[] = [];
  readonly viewports: { width: number; height: number }[] = [];
  gotoStatus = 200;
  gotoHeaders: Record<string, string> = { 'content-type': 'text/html' };
  gotoError: Error | undefined;
  gotoReturnsNull = false;
  contentError: Error | undefined;
  htmlContent = '<html><body>rendered</body></html>';
  /** The route the navigation should present to the handler, if any. */
  navigationRoute: FakeRoute | undefined;

  url = vi.fn(() => 'https://example.test/');
  setViewportSize = vi.fn(async (viewport: { width: number; height: number }) => {
    this.viewports.push(viewport);
  });

  route = vi.fn(
    async (matcher: RouteHandlerEntry['matcher'], handler: RouteHandlerEntry['handler']) => {
      this.routes.push({ matcher, handler });
    },
  );

  goto = vi.fn(async () => {
    // Route handlers registered last run first, matching Playwright.
    if (this.navigationRoute) {
      for (const entry of [...this.routes].reverse()) {
        await entry.handler(this.navigationRoute);
        if (!this.navigationRoute.fellBack) {
          break;
        }
        this.navigationRoute.fellBack = false;
      }
    }
    if (this.gotoError) {
      throw this.gotoError;
    }
    if (this.gotoReturnsNull) {
      return null;
    }
    return {
      status: () => this.gotoStatus,
      allHeaders: async () => this.gotoHeaders,
    };
  });

  content = vi.fn(async () => {
    if (this.contentError) {
      throw this.contentError;
    }
    return this.htmlContent;
  });

  // Readiness: parsed, and no renderReady flag declared.
  evaluate = vi.fn(async () => ({ domReady: true, renderReady: null }));

  on = vi.fn();
  off = vi.fn();

  waitForLoadState = vi.fn();
}

const asPage = (page: FakePage): Page => page as unknown as Page;

const options = (overrides: Partial<RenderPageOptions> = {}): RenderPageOptions => ({
  url: 'https://example.test/',
  viewport: { width: 1440, height: 718 },
  timeoutMs: 5_000,
  followRedirects: false,
  readiness: { pageDoneCheckInterval: 5, waitAfterLastRequest: 0, renderReadyDelay: 10 },
  blockedResourceTypes: [],
  blockedUrlPatterns: [],
  logger: noopLogger,
  ...overrides,
});

describe('renderPage', () => {
  it('navigates, waits for readiness and returns the HTML', async () => {
    const page = new FakePage();

    const result = await renderPage(asPage(page), options());

    expect(result).toMatchObject({
      html: '<html><body>rendered</body></html>',
      status: 200,
      isRedirect: false,
      timedOut: false,
    });
  });

  it('sets the requested viewport', async () => {
    const page = new FakePage();

    await renderPage(asPage(page), options({ viewport: { width: 640, height: 480 } }));

    expect(page.viewports).toEqual([{ width: 640, height: 480 }]);
  });

  // Readiness is decided by the poll loop; waiting on a load state would
  // reintroduce the networkidle problem this design exists to avoid.
  it('never waits on a Playwright load state', async () => {
    const page = new FakePage();

    await renderPage(asPage(page), options());

    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('commits the navigation rather than waiting for load', async () => {
    const page = new FakePage();

    await renderPage(asPage(page), options());

    expect(page.goto).toHaveBeenCalledWith(
      'https://example.test/',
      expect.objectContaining({ waitUntil: 'commit' }),
    );
  });

  it('passes the origin response headers through', async () => {
    const page = new FakePage();
    page.gotoHeaders = { 'content-type': 'text/html', 'x-custom': 'yes' };

    const result = await renderPage(asPage(page), options());

    expect(result.headers).toEqual({ 'content-type': 'text/html', 'x-custom': 'yes' });
  });

  it('passes a 5xx status through instead of failing', async () => {
    const page = new FakePage();
    page.gotoStatus = 503;

    const result = await renderPage(asPage(page), options());

    expect(result.status).toBe(503);
    expect(result.isRedirect).toBe(false);
  });

  // Every render gets an empty cache, so there is nothing for a caller to
  // revalidate a 304 against.
  it('reports a 304 as 200', async () => {
    const page = new FakePage();
    page.gotoStatus = 304;

    expect((await renderPage(asPage(page), options())).status).toBe(200);
  });

  it('reports status 0 when there is no response object', async () => {
    const page = new FakePage();
    page.gotoReturnsNull = true;

    const result = await renderPage(asPage(page), options());

    expect(result.status).toBe(0);
    expect(result.headers).toEqual({});
  });

  it('raises a RenderError when navigation fails', async () => {
    const page = new FakePage();
    page.gotoError = new Error('net::ERR_NAME_NOT_RESOLVED');

    await expect(renderPage(asPage(page), options())).rejects.toThrow(RenderError);
    await expect(renderPage(asPage(page), options())).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });

  it('raises a RenderError when the content cannot be read', async () => {
    const page = new FakePage();
    page.contentError = new Error('Target closed');

    await expect(renderPage(asPage(page), options())).rejects.toThrow(/Could not read the page/);
  });

  it('captures partial HTML when readiness times out', async () => {
    const page = new FakePage();
    page.evaluate.mockResolvedValue({ domReady: false, renderReady: null });

    const result = await renderPage(asPage(page), options({ timeoutMs: 30 }));

    expect(result.timedOut).toBe(true);
    expect(result.html).toBe('<html><body>rendered</body></html>');
  });

  describe('redirect detection', () => {
    it('returns the 3xx without loading the destination', async () => {
      const page = new FakePage();
      const apiResponse = new FakeApiResponse(302, { location: 'https://example.test/new' });
      page.navigationRoute = new FakeRoute('https://example.test/', 'document', apiResponse);
      page.gotoError = new Error('net::ERR_ABORTED');

      const result = await renderPage(asPage(page), options());

      expect(result).toMatchObject({ status: 302, isRedirect: true, html: '' });
      expect(result.headers.location).toBe('https://example.test/new');
      expect(page.navigationRoute.aborted).toBe(true);
      expect(page.navigationRoute.fulfilled).toBe(false);
    });

    it('re-fetches the document with redirects disabled', async () => {
      const page = new FakePage();
      const apiResponse = new FakeApiResponse(301, { location: '/moved' });
      page.navigationRoute = new FakeRoute('https://example.test/', 'document', apiResponse);
      page.gotoError = new Error('net::ERR_ABORTED');

      await renderPage(asPage(page), options());

      expect(page.navigationRoute.fetch).toHaveBeenCalledWith({ maxRedirects: 0 });
    });

    it('fulfills the navigation from its own fetch on a non-redirect', async () => {
      const page = new FakePage();
      const apiResponse = new FakeApiResponse(200, { 'content-type': 'text/html' });
      page.navigationRoute = new FakeRoute('https://example.test/', 'document', apiResponse);

      const result = await renderPage(asPage(page), options());

      expect(page.navigationRoute.fulfilled).toBe(true);
      expect(result.isRedirect).toBe(false);
      expect(result.html).toBe('<html><body>rendered</body></html>');
    });

    // Not disposing retains the response body for the life of the context, which
    // leaks steadily under load. This was a real production fix.
    it('always disposes the intercepted response', async () => {
      const redirectResponse = new FakeApiResponse(302, {});
      const redirectPage = new FakePage();
      redirectPage.navigationRoute = new FakeRoute(
        'https://example.test/',
        'document',
        redirectResponse,
      );
      redirectPage.gotoError = new Error('net::ERR_ABORTED');
      await renderPage(asPage(redirectPage), options());
      expect(redirectResponse.disposed).toBe(true);

      const okResponse = new FakeApiResponse(200, {});
      const okPage = new FakePage();
      okPage.navigationRoute = new FakeRoute('https://example.test/', 'document', okResponse);
      await renderPage(asPage(okPage), options());
      expect(okResponse.disposed).toBe(true);
    });

    it('falls back to a normal navigation when the probe fetch fails', async () => {
      const page = new FakePage();
      const route = new FakeRoute('https://example.test/', 'document');
      route.fetchError = new Error('connection reset');
      page.navigationRoute = route;

      const result = await renderPage(asPage(page), options());

      expect(route.continued).toBe(true);
      expect(result.isRedirect).toBe(false);
      expect(result.status).toBe(200);
    });

    it('leaves a non-document request at the same URL to the handler underneath', async () => {
      const page = new FakePage();
      const route = new FakeRoute('https://example.test/', 'xhr');
      page.navigationRoute = route;

      await renderPage(asPage(page), options());

      expect(route.fetch).not.toHaveBeenCalled();
    });

    it('installs no interceptor at all when following redirects', async () => {
      const page = new FakePage();
      const route = new FakeRoute(
        'https://example.test/',
        'document',
        new FakeApiResponse(302, {}),
      );
      page.navigationRoute = route;

      const result = await renderPage(asPage(page), options({ followRedirects: true }));

      expect(page.routes).toHaveLength(0);
      expect(route.fetch).not.toHaveBeenCalled();
      expect(result.isRedirect).toBe(false);
    });

    it('propagates a genuine navigation failure rather than reporting a redirect', async () => {
      const page = new FakePage();
      const route = new FakeRoute(
        'https://example.test/',
        'document',
        new FakeApiResponse(200, {}),
      );
      page.navigationRoute = route;
      page.gotoError = new Error('net::ERR_CONNECTION_REFUSED');

      await expect(renderPage(asPage(page), options())).rejects.toThrow(RenderError);
    });
  });

  describe('resource blocking', () => {
    it('installs no handler when nothing is configured', async () => {
      const page = new FakePage();

      await renderPage(asPage(page), options({ followRedirects: true }));

      expect(page.routes).toHaveLength(0);
    });

    it('registers the blocklist beneath the redirect interceptor', async () => {
      const page = new FakePage();

      await renderPage(asPage(page), options({ blockedResourceTypes: ['image'] }));

      // Order matters: Playwright runs the last-registered handler first, so the
      // document interceptor must be registered after the blocklist.
      expect(page.routes).toHaveLength(2);
      expect(page.routes[0]?.matcher).toBe('**/*');
      expect(typeof page.routes[1]?.matcher).toBe('function');
    });

    it('aborts a blocked resource type and allows everything else', async () => {
      const page = new FakePage();
      await renderPage(asPage(page), options({ blockedResourceTypes: ['image', 'media'] }));
      const blocker = page.routes[0]?.handler;

      const image = new FakeRoute('https://cdn.test/a.png', 'image');
      await blocker?.(image);
      expect(image.aborted).toBe(true);

      const script = new FakeRoute('https://cdn.test/a.js', 'script');
      await blocker?.(script);
      expect(script.continued).toBe(true);
    });

    it('aborts a request whose URL matches a blocked pattern', async () => {
      const page = new FakePage();
      await renderPage(asPage(page), options({ blockedUrlPatterns: ['google-analytics.com'] }));
      const blocker = page.routes[0]?.handler;

      const tracker = new FakeRoute('https://www.google-analytics.com/collect', 'script');
      await blocker?.(tracker);
      expect(tracker.aborted).toBe(true);

      const allowed = new FakeRoute('https://example.test/app.js', 'script');
      await blocker?.(allowed);
      expect(allowed.continued).toBe(true);
    });
  });
});
