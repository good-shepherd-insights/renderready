import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig, type RenderReadyOptions } from '../../src/config.js';
import {
  BrowserUnavailableError,
  InvalidUrlError,
  RenderError,
  UrlNotAllowedError,
} from '../../src/errors.js';
import { noopLogger } from '../../src/logger.js';
import type { Renderer, RenderResult } from '../../src/render/renderer.js';
import { createServer, type RenderReadyServer } from '../../src/server/createServer.js';

/**
 * A stub renderer. The renderer itself has its own suite; these tests are about
 * the HTTP contract — status codes, headers, validation, auth — so driving it
 * through `fastify.inject()` keeps them fast and port-free.
 */
function stubRenderer(
  overrides: Partial<Renderer> = {},
  options: RenderReadyOptions = {},
): Renderer {
  const config = resolveConfig(options, {});
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    render: vi.fn(async (url: string): Promise<RenderResult> => ({
      url,
      renderId: 'render-1',
      html: '<html><body>ok</body></html>',
      statusCode: 200,
      headers: {},
      isRedirect: false,
      timedOut: false,
      durationMs: 12,
    })),
    isReady: vi.fn(() => true),
    stats: vi.fn(() => ({ ready: true, inFlight: 0, renderCount: 3, uptimeMs: 1_000 })),
    config,
    logger: noopLogger,
    ...overrides,
  };
}

let server: RenderReadyServer | undefined;

function build(renderer: Renderer): RenderReadyServer {
  server = createServer({ renderer });
  return server;
}

beforeEach(() => {
  server = undefined;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('GET /health', () => {
  it('reports ok with browser stats when ready', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      browser: { ready: true, renderCount: 3 },
    });
    expect(response.json().version).toBeTruthy();
  });

  it('reports 503 while the browser is unavailable', async () => {
    const active = build(
      stubRenderer({
        stats: vi.fn(() => ({ ready: false, inFlight: 0, renderCount: 0, uptimeMs: 0 })),
      }),
    );

    const response = await active.fastify.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe('unavailable');
  });

  it('is never cached', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({ method: 'GET', url: '/health' });

    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /render', () => {
  it('returns the rendered HTML as text/html', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https%3A%2F%2Fexample.test%2F',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toBe('<html><body>ok</body></html>');
  });

  it('reports the render id so a response can be traced', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
    });

    expect(response.headers['x-renderready-render-id']).toBe('render-1');
  });

  it('passes query options through to the renderer', async () => {
    const renderer = stubRenderer();
    const active = build(renderer);

    await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/&width=800&height=600&userAgent=Bot%2F1&followRedirects=true&timeout=5000',
    });

    expect(renderer.render).toHaveBeenCalledWith('https://a.test/', {
      width: 800,
      height: 600,
      userAgent: 'Bot/1',
      followRedirects: true,
      timeout: 5000,
    });
  });

  it('omits absent options rather than passing undefined', async () => {
    const renderer = stubRenderer();
    const active = build(renderer);

    await active.fastify.inject({ method: 'GET', url: '/render?url=https://a.test/' });

    expect(renderer.render).toHaveBeenCalledWith('https://a.test/', {});
  });

  it('reports the page status, not 200', async () => {
    const renderer = stubRenderer({
      render: vi.fn(async (url: string) => ({
        url,
        renderId: 'r',
        html: '<html>gone</html>',
        statusCode: 410,
        headers: {},
        isRedirect: false,
        timedOut: false,
        durationMs: 1,
      })),
    });
    const active = build(renderer);

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
    });

    expect(response.statusCode).toBe(410);
  });

  it('returns a redirect with its Location header and an empty body', async () => {
    const renderer = stubRenderer({
      render: vi.fn(async (url: string) => ({
        url,
        renderId: 'r',
        html: '',
        statusCode: 301,
        headers: { location: 'https://a.test/moved' },
        isRedirect: true,
        timedOut: false,
        durationMs: 1,
      })),
    });
    const active = build(renderer);

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe('https://a.test/moved');
    expect(response.body).toBe('');
  });

  it('flags a partial capture so a caller can decline to cache it', async () => {
    const renderer = stubRenderer({
      render: vi.fn(async (url: string) => ({
        url,
        renderId: 'r',
        html: '<html>partial</html>',
        statusCode: 200,
        headers: {},
        isRedirect: false,
        timedOut: true,
        durationMs: 1,
      })),
    });
    const active = build(renderer);

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
    });

    expect(response.headers['x-renderready-timed-out']).toBe('1');
  });

  it('does not set the timed-out header on a complete render', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
    });

    expect(response.headers['x-renderready-timed-out']).toBeUndefined();
  });

  describe('header pass-through', () => {
    const withHeaders = (headers: Record<string, string>) =>
      stubRenderer({
        render: vi.fn(async (url: string) => ({
          url,
          renderId: 'r',
          html: '<html>ok</html>',
          statusCode: 200,
          headers,
          isRedirect: false,
          timedOut: false,
          durationMs: 1,
        })),
      });

    it('forwards useful origin headers', async () => {
      const active = build(
        withHeaders({ 'x-custom': 'yes', link: '<https://a.test/>; rel=preload' }),
      );

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.headers['x-custom']).toBe('yes');
      expect(response.headers.link).toBe('<https://a.test/>; rel=preload');
    });

    // These describe the origin's connection or the untransformed body, so
    // forwarding them produces a malformed or misleading response. Asserted
    // against a sentinel value rather than `undefined`, because our own HTTP
    // layer legitimately sets some of these (connection, keep-alive) itself.
    it.each([
      'transfer-encoding',
      'connection',
      'keep-alive',
      'content-encoding',
      'upgrade',
      'te',
      'trailer',
    ])('does not forward the origin hop-by-hop header %s', async header => {
      const active = build(withHeaders({ [header]: 'from-origin' }));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.headers[header]).not.toBe('from-origin');
    });

    // Content-Length would describe the body before scripts were stripped.
    it('recomputes content-length rather than trusting the origin', async () => {
      const active = build(withHeaders({ 'content-length': '99999' }));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.headers['content-length']).toBe(String(Buffer.byteLength('<html>ok</html>')));
    });

    // Forwarding the origin's session cookies to whoever asked for a render is a
    // real leak; the prerender package passed them straight through.
    it('never forwards set-cookie', async () => {
      const active = build(withHeaders({ 'set-cookie': 'session=secret; HttpOnly' }));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('overrides the origin content-type, since the body is always UTF-8 HTML', async () => {
      const active = build(withHeaders({ 'content-type': 'text/html; charset=iso-8859-1' }));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    });
  });

  describe('validation', () => {
    it('rejects a missing url with 400', async () => {
      const active = build(stubRenderer());

      const response = await active.fastify.inject({ method: 'GET', url: '/render' });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Bad Request');
    });

    it('rejects an unknown query parameter', async () => {
      const active = build(stubRenderer());

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/&renderType=pdf',
      });

      expect(response.statusCode).toBe(400);
    });

    it.each([
      ['a non-integer width', 'width=abc'],
      ['a zero width', 'width=0'],
      ['an absurd width', 'width=99999'],
      ['a zero timeout', 'timeout=0'],
    ])('rejects %s', async (_label, param) => {
      const active = build(stubRenderer());

      const response = await active.fastify.inject({
        method: 'GET',
        url: `/render?url=https://a.test/&${param}`,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('error mapping', () => {
    const failingWith = (error: Error) =>
      stubRenderer({
        render: vi.fn(async () => {
          throw error;
        }),
      });

    it('maps an invalid URL to 400', async () => {
      const active = build(failingWith(new InvalidUrlError('Not a valid absolute URL')));

      const response = await active.fastify.inject({ method: 'GET', url: '/render?url=nope' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'INVALID_URL' });
    });

    it('maps an excluded domain to 404', async () => {
      const active = build(failingWith(new UrlNotAllowedError('not allowed')));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: 'URL_NOT_ALLOWED' });
    });

    it('maps browser unavailability to 503 with Retry-After', async () => {
      const active = build(failingWith(new BrowserUnavailableError('relaunching')));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
    });

    it('maps a render failure to the configured renderErrorStatusCode', async () => {
      const renderer = stubRenderer(
        {
          render: vi.fn(async () => {
            throw new RenderError('navigation failed');
          }),
        },
        { renderErrorStatusCode: 502 },
      );
      const active = build(renderer);

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.statusCode).toBe(502);
    });

    it('maps an unexpected error to renderErrorStatusCode too', async () => {
      const active = build(failingWith(new Error('something odd')));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({ error: 'RENDER_FAILED' });
    });

    // The equivalent of the prerender package's x-prerender-504-reason: a bare
    // status rarely says enough to debug from the caller's side.
    it('reports the reason in a response header', async () => {
      const active = build(failingWith(new RenderError('net::ERR_NAME_NOT_RESOLVED')));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      expect(response.headers['x-renderready-error']).toContain('ERR_NAME_NOT_RESOLVED');
    });

    it('sanitizes a multi-line or non-ASCII error into a legal header value', async () => {
      const active = build(failingWith(new RenderError('line one\r\nline two — dash')));

      const response = await active.fastify.inject({
        method: 'GET',
        url: '/render?url=https://a.test/',
      });

      const header = response.headers['x-renderready-error'] as string;
      expect(header).not.toMatch(/[\r\n]/);
      expect(header).toContain('line one line two');
    });
  });
});

describe('POST /render', () => {
  it('accepts a JSON body, avoiding URL-encoding problems', async () => {
    const renderer = stubRenderer();
    const active = build(renderer);

    const response = await active.fastify.inject({
      method: 'POST',
      url: '/render',
      payload: { url: 'https://a.test/search?q=a&b=c', width: 375 },
    });

    expect(response.statusCode).toBe(200);
    expect(renderer.render).toHaveBeenCalledWith('https://a.test/search?q=a&b=c', { width: 375 });
  });

  it('rejects a body with no url', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({ method: 'POST', url: '/render', payload: {} });

    expect(response.statusCode).toBe(400);
  });
});

describe('routing', () => {
  // The prerender package served GET /<url>; that catch-all is deliberately gone,
  // so an unknown path must be an honest 404 rather than an attempted render.
  it('does not treat an arbitrary path as a URL to render', async () => {
    const renderer = stubRenderer();
    const active = build(renderer);

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/https://example.test/',
    });

    expect(response.statusCode).toBe(404);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('points an unknown route at the real one', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({ method: 'GET', url: '/nope' });

    expect(response.json().message).toContain('/render?url=');
  });

  it('exposes the fastify instance so extra routes can be added', async () => {
    const active = build(stubRenderer());
    active.fastify.get('/custom', () => ({ custom: true }));

    const response = await active.fastify.inject({ method: 'GET', url: '/custom' });

    expect(response.json()).toEqual({ custom: true });
  });
});

describe('basic auth', () => {
  const credentials = { username: 'crawler', password: 'secret' };
  const encode = (value: string): string => `Basic ${Buffer.from(value).toString('base64')}`;

  const authServer = () => build(stubRenderer({}, { basicAuth: credentials }));

  it('allows a request with the right credentials', async () => {
    const active = authServer();

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
      headers: { authorization: encode('crawler:secret') },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a request with no credentials', async () => {
    const active = authServer();

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Basic');
  });

  it.each([
    ['a wrong password', 'crawler:wrong'],
    ['a wrong username', 'other:secret'],
    ['a shorter value', 'a:b'],
    ['a longer value', 'crawler:secret-and-more'],
  ])('rejects %s', async (_label, value) => {
    const active = authServer();

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
      headers: { authorization: encode(value) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const active = authServer();

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(401);
  });

  // Probes frequently cannot carry credentials, and a health check that always
  // 401s is worse than useless.
  it('leaves /health reachable', async () => {
    const active = authServer();

    const response = await active.fastify.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });

  it('is absent when no credentials are configured', async () => {
    const active = build(stubRenderer());

    const response = await active.fastify.inject({
      method: 'GET',
      url: '/render?url=https://a.test/',
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('lifecycle', () => {
  it('starts the renderer on listen and stops it on close', async () => {
    const renderer = stubRenderer();
    const active = createServer({ renderer, port: 0 });
    server = active;

    const url = await active.listen();
    expect(renderer.start).toHaveBeenCalledTimes(1);
    expect(url).toMatch(/^http:\/\//);
    expect(active.url).toBe(url);

    await active.close();
    expect(renderer.stop).toHaveBeenCalledTimes(1);
    expect(active.url).toBeUndefined();
  });

  it('is safe to close twice', async () => {
    const renderer = stubRenderer();
    const active = createServer({ renderer, port: 0 });
    server = active;
    await active.listen();

    await active.close();
    await active.close();

    expect(renderer.stop).toHaveBeenCalledTimes(1);
  });

  it('serves real HTTP requests once listening', async () => {
    const renderer = stubRenderer();
    const active = createServer({ renderer, port: 0, host: '127.0.0.1' });
    server = active;
    const url = await active.listen();

    const response = await fetch(`${url}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });
});
