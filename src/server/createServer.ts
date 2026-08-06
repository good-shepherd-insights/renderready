import { timingSafeEqual } from 'node:crypto';

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import { errorMessage, isRenderReadyError } from '../errors.js';
import type { Logger } from '../logger.js';
import { createRenderer, type Renderer, type RendererOptions } from '../render/renderer.js';
import { VERSION } from '../version.js';

import { renderRequestSchema, type RenderRequest } from './schema.js';

/**
 * Headers we never copy from the origin to the caller.
 *
 * The hop-by-hop ones describe the origin connection, not ours, and passing them
 * on produces a malformed response. `content-length` and `content-encoding` would
 * describe the *untransformed* body — we stripped scripts, so both are wrong.
 * `set-cookie` is dropped because the origin's session cookies are none of the
 * caller's business and forwarding them is a genuine leak.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  // We always send UTF-8 HTML; the origin's own value may disagree.
  'content-type',
]);

export interface ServerOptions extends RendererOptions {
  /**
   * Install SIGTERM/SIGINT handlers that close the server and browser cleanly.
   *
   * Off by default: a library has no business hijacking process signals. `start()`
   * turns it on, because that is the batteries-included entry point.
   */
  handleSignals?: boolean;
  /** Supply a renderer instead of building one. Mainly for tests. */
  renderer?: Renderer;
}

export interface RenderReadyServer {
  /** Start listening. Resolves with the base URL once bound. */
  listen(): Promise<string>;
  /** Stop accepting requests, then close the browser. */
  close(): Promise<void>;
  /** The base URL, available after `listen()`. */
  readonly url: string | undefined;
  /** Escape hatch for adding routes, plugins or middleware. */
  readonly fastify: FastifyInstance;
  readonly renderer: Renderer;
}

/**
 * Build the HTTP server around a renderer.
 *
 * Two endpoints and nothing else: `/render` and `/health`. The legacy
 * `GET /<url>` catch-all from the prerender package is deliberately absent.
 */
export function createServer(options: ServerOptions = {}): RenderReadyServer {
  const renderer = options.renderer ?? createRenderer(options);
  const { config, logger } = renderer;

  const fastify = Fastify({
    // We do our own logging through the injectable logger, which also means
    // there is no request logging to disable.
    logger: false,
    ajv: {
      customOptions: {
        // Fastify defaults this to true, which silently deletes unknown
        // properties. A misspelled option should be a 400, not a no-op.
        removeAdditional: false,
        // Query strings arrive as strings; `?width=800` must become a number.
        coerceTypes: true,
      },
    },
  });

  if (config.access.basicAuth) {
    installBasicAuth(fastify, config.access.basicAuth, logger);
  }

  fastify.get('/health', async (_request, reply) => {
    const stats = renderer.stats();
    const healthy = stats.ready;
    return reply
      .code(healthy ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({
        status: healthy ? 'ok' : 'unavailable',
        version: VERSION,
        browser: stats,
      });
  });

  fastify.get<{ Querystring: RenderRequest }>(
    '/render',
    { schema: { querystring: renderRequestSchema } },
    (request, reply) => handleRender(request.query, reply, renderer),
  );

  fastify.post<{ Body: RenderRequest }>(
    '/render',
    { schema: { body: renderRequestSchema } },
    (request, reply) => handleRender(request.body, reply, renderer),
  );

  // Fastify's default 400 for a schema failure is fine, but a bad `url` should
  // read the same whether the schema or our own validation caught it.
  fastify.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: 'Bad Request', message: error.message });
    }
    logger.error('Unhandled server error', { error: errorMessage(error) });
    return reply.code(500).send({ error: 'Internal Server Error' });
  });

  fastify.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: 'Not Found',
      message: `No route for ${request.method} ${request.url}. Try GET /render?url=...`,
    }),
  );

  let baseUrl: string | undefined;
  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    // Idempotent: signal handlers and an explicit close() can race.
    closing ??= (async () => {
      logger.info('Shutting down');
      await fastify.close();
      await renderer.stop();
      baseUrl = undefined;
    })();
    return closing;
  };

  const listen = async (): Promise<string> => {
    await renderer.start();
    const address = await fastify.listen({ port: config.server.port, host: config.server.host });
    baseUrl = address;
    logger.info('Listening', { address, version: VERSION });

    if (options.handleSignals) {
      installSignalHandlers(close, logger);
    }
    return address;
  };

  return {
    listen,
    close,
    get url() {
      return baseUrl;
    },
    fastify,
    renderer,
  };
}

/**
 * `start()` in one call: build the server, launch the browser, listen, and wire
 * signal handling. This is the documented entry point.
 */
export async function start(options: ServerOptions = {}): Promise<RenderReadyServer> {
  const server = createServer({ handleSignals: true, ...options });
  await server.listen();
  return server;
}

async function handleRender(
  input: RenderRequest,
  reply: FastifyReply,
  renderer: Renderer,
): Promise<FastifyReply> {
  const { config, logger } = renderer;

  try {
    const result = await renderer.render(input.url, {
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      ...(input.followRedirects !== undefined ? { followRedirects: input.followRedirects } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    });

    for (const [name, value] of Object.entries(result.headers)) {
      if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
        reply.header(name, value);
      }
    }

    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('x-renderready-render-id', result.renderId);
    if (result.timedOut) {
      // Surfaced so a caller can decide not to cache a partial capture.
      reply.header('x-renderready-timed-out', '1');
    }

    return reply.code(result.statusCode).send(result.html);
  } catch (error) {
    const status = isRenderReadyError(error)
      ? (error.statusCode ?? config.render.renderErrorStatusCode)
      : config.render.renderErrorStatusCode;
    const message = errorMessage(error);

    logger.warn('Render failed', { url: input.url, status, error: message });

    // The equivalent of the prerender package's x-prerender-504-reason: the
    // status alone rarely says enough to debug from the caller's side.
    reply.header('x-renderready-error', sanitizeHeaderValue(message));

    if (status === 503) {
      reply.header('retry-after', '1');
    }

    return reply.code(status).send({
      error: isRenderReadyError(error) ? error.code : 'RENDER_FAILED',
      message,
    });
  }
}

/** Header values must be single-line Latin-1; a render error message may not be. */
function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 400);
}

function installBasicAuth(
  fastify: FastifyInstance,
  credentials: { username: string; password: string },
  logger: Logger,
): void {
  const expected = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8');

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Health must stay reachable for probes that cannot carry credentials.
    if (request.url.startsWith('/health')) {
      return;
    }

    const header = request.headers.authorization;
    const encoded = typeof header === 'string' ? /^Basic (.+)$/i.exec(header)?.[1] : undefined;
    const provided = encoded === undefined ? undefined : Buffer.from(encoded, 'base64');

    // Length is compared separately because timingSafeEqual throws on a mismatch.
    const ok =
      provided !== undefined &&
      provided.length === expected.length &&
      timingSafeEqual(provided, expected);

    if (!ok) {
      logger.warn('Rejected unauthenticated request', { url: request.url });
      await reply
        .code(401)
        .header('www-authenticate', 'Basic realm="renderready"')
        .send({ error: 'Unauthorized' });
    }
  });
}

function installSignalHandlers(close: () => Promise<void>, logger: Logger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info('Received signal; shutting down', { signal });
      void close().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('Shutdown failed', { error: errorMessage(error) });
          process.exit(1);
        },
      );
    });
  }
}
