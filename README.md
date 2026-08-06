# renderready

[![npm](https://img.shields.io/npm/v/renderready?logo=npm)](https://www.npmjs.com/package/renderready)
[![CI](https://github.com/lukapozega/renderready/actions/workflows/ci.yml/badge.svg)](https://github.com/lukapozega/renderready/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/renderready)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/renderready)](./LICENSE)

Prerender any JavaScript web page to static HTML. Send it a URL over HTTP, get back the fully
rendered DOM — no `<script>` tags, correct status codes, ready for crawlers.

Built on Playwright and headless Chromium. Two runtime dependencies — `playwright-core` and
`fastify` — and no database, no queue broker, no cloud service.

```bash
npm install renderready
npx playwright install chromium
```

```js
import { start } from 'renderready';

await start();
```

```bash
curl 'http://localhost:3000/render?url=https%3A%2F%2Fexample.com%2F'
```

## Why this exists

Search engines and social crawlers still do a poor job of client-rendered pages, and the
long-standing open-source answers to that are either unmaintained or wrap Chrome over hand-rolled
DevTools Protocol calls.

renderready is a current-generation take: Playwright for the browser, TypeScript throughout, a
browser lifecycle that survives crashes and reclaims memory on its own, and readiness detection that
works on sites you do not control instead of only ones you have instrumented.

## Contents

- [Use cases](#use-cases)
- [API](#api)
- [HTTP endpoints](#http-endpoints)
- [How a page is judged "ready"](#how-a-page-is-judged-ready)
- [Status codes](#status-codes)
- [Options](#options)
- [Hooks](#hooks)
- [Errors](#errors)
- [Adding a cache](#adding-a-cache)
- [Docker](#docker)
- [Concurrency and capacity](#concurrency-and-capacity)
- [Security](#security)
- [Compatibility](#compatibility)
- [Requirements](#requirements)
- [Contributing](#contributing)

## Use cases

**SEO for client-rendered sites.** Detect crawler user agents at your edge or in middleware, and
proxy those requests to renderready while real users get your normal app. Because the response
carries the origin's status code, a soft 404 stays a 404 and a moved page stays a redirect.

**Scraping and content extraction.** `createRenderer()` gives you the render loop with no HTTP
layer, which is what you want inside a worker or a build step.

**Static snapshots.** Render a list of routes at build time and serve the HTML from a CDN.

## API

Three entry points, smallest first.

### `start(options?)`

Resolve configuration, launch the browser, listen, and install SIGTERM/SIGINT handlers.

```js
import { start } from 'renderready';

const server = await start({ port: 3000 });
// …
await server.close();
```

### `createServer(options?)`

The same server without the signal handling, and with the Fastify instance exposed so you can add
your own routes, plugins or middleware.

```js
import { createServer } from 'renderready';

const server = createServer({ port: 3000, pageLoadTimeout: 30_000 });

server.fastify.get('/metrics', () => collectMetrics());

await server.listen();
```

### `createRenderer(options?)`

No HTTP at all — just the renderer.

```js
import { createRenderer } from 'renderready';

const renderer = createRenderer({ allowedDomains: ['example.com'] });
await renderer.start();

const { html, statusCode, headers, timedOut, durationMs } = await renderer.render(
  'https://example.com/products/1',
);

await renderer.stop();
```

`render()` accepts per-request overrides: `{ width, height, userAgent, followRedirects, timeout }`.

### CLI

```
renderready [options]

  -p, --port <n>          Port to listen on
  -H, --host <addr>       Interface to bind
  -t, --timeout <ms>      Render budget per page
      --chrome <path>     Chrome/Chromium binary to use
      --allow <list>      Comma-separated domains to allow
      --block <list>      Comma-separated domains to block
      --log-level <l>     debug | info | warn | error | silent
      --keep-scripts      Leave <script> tags in the output
      --follow-redirects  Follow a redirect instead of returning the 3xx
  -h, --help
  -v, --version
```

## HTTP endpoints

### `GET /render?url=<encoded>`

Returns the rendered HTML with **the origin page's status code**. Optional query parameters:
`width`, `height`, `userAgent`, `followRedirects`, `timeout`.

The `url` value must be percent-encoded. An unencoded URL containing `&` or `?` will be truncated
by any query-string parser — use `POST` if that is awkward.

### `POST /render`

Same options as a JSON body, which avoids URL-encoding entirely:

```bash
curl -X POST http://localhost:3000/render \
  -H 'content-type: application/json' \
  -d '{"url": "https://example.com/search?q=a&b=c", "width": 375}'
```

An unknown option is a `400`, not a silent no-op.

### `GET /health`

`200` when the browser is up, `503` while it is relaunching. Suitable as a readiness probe.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "browser": { "ready": true, "inFlight": 0, "renderCount": 42, "uptimeMs": 91000 }
}
```

### Response headers

Headers from the origin are forwarded, except:

| Dropped                                                                                | Why                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `te`, `trailer`, `proxy-*` | Hop-by-hop: they describe the origin's connection, not ours |
| `content-length`, `content-encoding`                                                   | They describe the body _before_ scripts were stripped       |
| `content-type`                                                                         | The response is always `text/html; charset=utf-8`           |
| `set-cookie`                                                                           | The origin's session cookies are not the caller's business  |

renderready adds `x-renderready-render-id` on every response, `x-renderready-timed-out: 1` on a
partial capture, and `x-renderready-error` with the reason on a failure.

## How a page is judged "ready"

This is the only genuinely hard problem in prerendering, and renderready uses two signals. Which
one applies is up to the page.

**Network quiet** — no requests in flight, and none started or settled for `waitAfterLastRequest`
(default 500ms). This is the only signal available for a site you don't control, so it is the
fallback rather than the exception.

**`window.renderReady`** — if your page defines it as a boolean, it is authoritative. Nothing is
captured until it turns `true`. Once it does, capture happens as soon as the network is quiet _or_
`renderReadyDelay` (default 1000ms) elapses, whichever comes first — so an app that knows it is
finished can cut a render short instead of waiting out its own trailing analytics requests.

```html
<script>
  window.renderReady = false;
</script>
```

```js
// …once your data has loaded and the DOM is final:
window.renderReady = true;
```

If you never define the flag, nothing breaks — network quiet handles it.

renderready deliberately does **not** wait for Playwright's `networkidle`. Any SPA with
long-polling, streaming, or a keep-alive connection never reaches it, which would pin every render
at the full timeout. For the same reason, WebSocket and EventSource requests are excluded from the
in-flight count: they never finish.

A timeout is **not** an error. You get whatever had rendered, `timedOut: true`, and the
`x-renderready-timed-out` header, because partial content is usually more useful than nothing.

## Status codes

Resolved in increasing order of specificity:

1. Whatever the origin returned.
2. `renderErrorStatusCode` (default `504`) if there was no response at all.
3. `timeoutStatusCode`, if the render timed out and you configured one. Unset by default, meaning
   the origin's status is kept.
4. `<meta name="renderready-status-code">`, if the page declared one — your app knows its own routing
   better than our timeout heuristic does.

Soft 404s and client-side redirects are declared from the page itself:

```html
<!-- serve this route as a 404 so it is not indexed -->
<meta name="renderready-status-code" content="404" />
```

```html
<!-- serve this route as a redirect -->
<meta name="renderready-status-code" content="302" />
<meta name="renderready-header" content="Location: https://example.com/new" />
```

Both tags are read from `<head>` only — body content cannot spoof a status code — and stripped from
the output.

**Redirects are not followed by default.** A crawler needs to see the `301`/`302` so it can update
its index, so renderready returns the 3xx and its `Location` header without ever fetching the
destination. Pass `followRedirects=true` to render the destination instead.

## Options

Every option can be set programmatically or by environment variable. Precedence is
`option ?? environment ?? default`.

### Server

| Option | Env    | Default   |
| ------ | ------ | --------- |
| `port` | `PORT` | `3000`    |
| `host` | `HOST` | `0.0.0.0` |

### Browser

| Option                | Env                     | Default  |                                                                 |
| --------------------- | ----------------------- | -------- | --------------------------------------------------------------- |
| `chromePath`          | `CHROME_PATH`           | —        | Binary to use. Unset means Playwright's own installed Chromium. |
| `extraChromeArgs`     | `EXTRA_CHROME_ARGS`     | `[]`     | Extra flags, appended to the defaults.                          |
| `blockImages`         | `BLOCK_IMAGES`          | `true`   | Disable image loading in the engine.                            |
| `blockFonts`          | `BLOCK_FONTS`           | `true`   | Disable webfont loading in the engine.                          |
| `recycleAfterRenders` | `RECYCLE_AFTER_RENDERS` | `300`    | Relaunch the browser after this many renders.                   |
| `recycleAfterMs`      | `RECYCLE_AFTER_MS`      | `600000` | Relaunch once the browser is this old.                          |
| `relaunchWaitMs`      | `RELAUNCH_WAIT_MS`      | `30000`  | How long a render waits for an in-progress relaunch.            |

Images and fonts are disabled with Chromium flags rather than request interception. The output has
its scripts stripped and `<img>` elements serialize whether or not their bytes arrived, so image
data cannot affect the HTML you get back — and skipping decode inside Blink is far cheaper than
routing every request through Node to abort it.

### Rendering

| Option                  | Env                        | Default                  |                                                             |
| ----------------------- | -------------------------- | ------------------------ | ----------------------------------------------------------- |
| `pageLoadTimeout`       | `PAGE_LOAD_TIMEOUT`        | `20000`                  | Budget for the whole render.                                |
| `pageDoneCheckInterval` | `PAGE_DONE_CHECK_INTERVAL` | `500`                    | Readiness poll interval.                                    |
| `waitAfterLastRequest`  | `WAIT_AFTER_LAST_REQUEST`  | `500`                    | Network-quiet window.                                       |
| `renderReadyDelay`      | `RENDER_READY_DELAY`       | `1000`                   | Grace period after the flag turns true.                     |
| `followRedirects`       | `FOLLOW_REDIRECTS`         | `false`                  |                                                             |
| `timeoutStatusCode`     | `TIMEOUT_STATUS_CODE`      | `null`                   | `null` keeps the origin's status.                           |
| `renderErrorStatusCode` | `RENDER_ERROR_STATUS_CODE` | `504`                    |                                                             |
| `userAgent`             | `USER_AGENT`               | —                        | Unset means Chromium's own, with `Headless` removed.        |
| `viewportWidth`         | `VIEWPORT_WIDTH`           | `1440`                   |                                                             |
| `viewportHeight`        | `VIEWPORT_HEIGHT`          | `718`                    |                                                             |
| `originHeaders`         | —                          | `{'X-RenderReady': '1'}` | Sent **to the origin** so your app can detect the renderer. |

### Output

| Option             | Env                  | Default |                                                  |
| ------------------ | -------------------- | ------- | ------------------------------------------------ |
| `removeScriptTags` | `REMOVE_SCRIPT_TAGS` | `true`  | Strip `<script>`, keeping `application/ld+json`. |
| `absoluteUrls`     | `ABSOLUTE_URLS`      | `true`  | Rewrite root-relative `src`/`href` to absolute.  |
| `metaStatusCode`   | `META_STATUS_CODE`   | `true`  | Honor the `renderready-*` meta tags.             |
| `injectRenderMeta` | `INJECT_RENDER_META` | `false` | Add render-id/timestamp meta tags.               |

Scripts are stripped because the page is already rendered: leaving your framework's bootstrap in
place means a crawler that _does_ execute JavaScript may re-run routing and wipe the HTML you just
produced. `application/ld+json` is kept — it is content, not behaviour.

### Access control and blocking

| Option                 | Env                                           | Default |                                                           |
| ---------------------- | --------------------------------------------- | ------- | --------------------------------------------------------- |
| `allowedDomains`       | `ALLOWED_DOMAINS`                             | `[]`    | Non-empty means only these hosts (and subdomains) render. |
| `blockedDomains`       | `BLOCKED_DOMAINS`                             | `[]`    | Checked first, so it wins on overlap.                     |
| `blockedResourceTypes` | `BLOCKED_RESOURCE_TYPES`                      | `[]`    | e.g. `image,media,font`.                                  |
| `blockedUrlPatterns`   | `BLOCKED_URL_PATTERNS`                        | `[]`    | URL substrings to abort.                                  |
| `basicAuth`            | `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` | —       | `/health` stays open.                                     |

Domain matching compares hostname labels, so `example.com` matches `www.example.com` but **not**
`example.com.attacker.test`.

### Logging

| Option     | Env         | Default  |                                               |
| ---------- | ----------- | -------- | --------------------------------------------- |
| `logLevel` | `LOG_LEVEL` | `info`   | `debug`, `info`, `warn`, `error`, `silent`.   |
| `logger`   | —           | built-in | Anything implementing the `Logger` interface. |

```ts
import { createRenderer, type Logger } from 'renderready';
import pino from 'pino';

const log = pino();
const logger: Logger = {
  debug: (message, meta) => log.debug(meta, message),
  info: (message, meta) => log.info(meta, message),
  warn: (message, meta) => log.warn(meta, message),
  error: (message, meta) => log.error(meta, message),
};

createRenderer({ logger });
```

## Hooks

Hooks are the escape hatch for what a package cannot anticipate — caching, metrics, per-site
fixups. The behaviours nearly everyone wants are configuration flags above instead, because nobody
should have to wire those up by hand.

```ts
createRenderer({
  hooks: {
    // Before any browser work. Throw to reject.
    onRequest: ({ url }) => {
      if (url.includes('/admin')) throw new Error('not renderable');
    },

    // The page exists but has not navigated. addInitScript, cookies, routes.
    onPageCreated: async page => {
      await page.addInitScript(() => {
        window.__RENDERREADY__ = true;
      });
    },

    // After capture and transforms. Mutate html, statusCode or headers.
    onPageLoaded: context => {
      context.headers['x-rendered-by'] = 'renderready';
    },

    // Always fires, success or failure. For metrics.
    onRenderFinished: ({ url, statusCode, durationMs, error }) => {
      metrics.histogram('render_ms', durationMs, { status: statusCode });
      if (error) metrics.increment('render_errors');
    },
  },
});
```

A hook that throws fails the render — except `onRenderFinished`, whose errors are swallowed and
logged, because metrics code must not be able to break rendering.

## Errors

`renderer.render()` rejects with a typed error. Each one carries a stable `code` so you can branch
without matching on message text, and the ones whose HTTP meaning is intrinsic carry a `statusCode`
too.

| Class                     | `code`                  | `statusCode` | When                                                   |
| ------------------------- | ----------------------- | ------------ | ------------------------------------------------------ |
| `ConfigError`             | `INVALID_CONFIG`        | —            | Configuration failed validation at startup.            |
| `InvalidUrlError`         | `INVALID_URL`           | `400`        | The URL is absent, malformed, or not `http(s)`.        |
| `UrlNotAllowedError`      | `URL_NOT_ALLOWED`       | `404`        | Excluded by `allowedDomains` / `blockedDomains`.       |
| `BrowserUnavailableError` | `BROWSER_UNAVAILABLE`   | `503`        | Mid-relaunch and it did not come back. Retry.          |
| `BrowserLaunchError`      | `BROWSER_LAUNCH_FAILED` | —            | Chromium could not be launched at all. Fatal.          |
| `RenderError`             | `RENDER_FAILED`         | —            | Navigation or content extraction failed for this page. |

All of them extend `RenderReadyError`. Use `isRenderReadyError()` to narrow an `unknown`:

```ts
import { createRenderer, isRenderReadyError, UrlNotAllowedError } from 'renderready';

try {
  await renderer.render(url);
} catch (error) {
  if (error instanceof UrlNotAllowedError) {
    return reply.code(404).send();
  }
  if (isRenderReadyError(error)) {
    // `code` is a stable union; `statusCode` may be undefined.
    return reply.code(error.statusCode ?? 504).send({ code: error.code });
  }
  throw error;
}
```

`UrlNotAllowedError` is a `404` rather than a `403` on purpose: an excluded host should look like it
simply is not there, instead of advertising that a filter exists and that you tripped it.

`BrowserLaunchError` is the one to treat as fatal — nothing the process does afterwards will render
anything. Pass `onFatal` to be told about it, which is what the CLI uses to exit non-zero so a
supervisor restarts it.

## Adding a cache

There is no built-in cache: what to key on, how long to keep it, and where to put it are decisions
only you can make. Two hooks are all it takes.

```ts
const cache = new Map<string, { html: string; statusCode: number }>();

createRenderer({
  hooks: {
    onRequest: ({ url }) => {
      const hit = cache.get(url);
      if (hit) throw new CacheHit(hit); // your own control-flow error
    },
    onPageLoaded: ({ url, html, statusCode, timedOut }) => {
      // Never cache a partial capture.
      if (!timedOut && statusCode === 200) cache.set(url, { html, statusCode });
    },
  },
});
```

For a real deployment, prefer a cache in front of the service — Varnish, nginx, or a CDN — keyed on
the full URL. Rendering is the expensive part; HTTP caches already solve the rest.

## Docker

The image is built on Microsoft's Playwright base image, which already has Chromium and its system
libraries.

```bash
docker compose up
curl 'http://localhost:3000/render?url=https%3A%2F%2Fexample.com%2F'
```

> **If you write your own Dockerfile, use an init process.** `tini`, `docker run --init`, or
> Kubernetes' `shareProcessNamespace` — something that reaps orphans. Every browser recycle kills
> Chromium, and its five or so child processes (renderer, GPU, zygote, crashpad) reparent to PID 1.
> Node does not `wait()` on them, so without an init process you leak a set of zombies per recycle
> until the PID table fills. The bundled Dockerfile handles this.

`--no-sandbox` is on by default because Chromium's sandbox does not work in most container
configurations. See [Security](#security).

## Concurrency and capacity

**renderready does not limit concurrency.** Renders run in parallel, each in its own browser
context, bounded only by what Chromium tolerates. Rate limiting, queueing
and back-pressure belong to whatever sits in front of the service, where you can size them against
your actual traffic.

`recycleAfterRenders` and `recycleAfterMs` are **not** throughput controls. They exist because a
long-lived Chromium process leaks memory; periodically relaunching it is the cheapest fix. A
recycle drains in-flight renders first, so no response is truncated, and `/health` reports `503`
for its duration.

A single render holds a browser context, which is roughly 30–60MB of Chromium memory. Plan capacity
from that, and remember `--disable-dev-shm-usage` is already set because the default Docker
`/dev/shm` is too small.

## Security

**Treat the render endpoint as privileged.** Anything that can reach it can make your server fetch
arbitrary URLs from wherever it is deployed — a classic SSRF position. If the URL comes from
outside your own system:

- Set `allowedDomains` to the hosts you actually want rendered. This is the single most effective
  control.
- Put the service on a private network, or enable `basicAuth`.
- Do not run it somewhere with access to cloud metadata endpoints or internal admin panels.

renderready refuses non-`http(s)` URLs, so `file://` and `data:` cannot be used to read from the
host. It does **not** attempt to block private IP ranges: doing that safely requires resolving DNS
yourself and defeating rebinding, which is a network-level concern rather than something this
package can honestly promise. Use `allowedDomains` or a network policy.

`--no-sandbox` is enabled by default so Chromium runs in ordinary containers. That means a Chromium
renderer exploit is not contained by the sandbox. If you render untrusted URLs, run the service in
its own container with a seccomp profile and no network access beyond what it needs.

To report a vulnerability, please open a draft security advisory on GitHub rather than a public
issue.

## Compatibility

Deliberately **not** included, so you know what to expect:

| Not supported                       | Why                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| A catch-all `GET /<url>` route      | Ambiguous, and it makes every typo look like a render request. Use `/render?url=`.   |
| Screenshots, PDF, HAR output        | Out of scope for v1. Playwright makes them easy to add on top of `createRenderer()`. |
| `_escaped_fragment_` query handling | Google retired the AJAX crawling scheme in 2015.                                     |
| A built-in cache                    | See [Adding a cache](#adding-a-cache) — an HTTP cache in front is better.            |
| A concurrency limiter               | See [Concurrency and capacity](#concurrency-and-capacity).                           |

If you are moving from another prerendering service, the two things to check are that your
application sets `window.renderReady` (or relies on network quiet, which needs no changes) and that
any soft-404 meta tags use the `renderready-` prefix documented above.

## Requirements

Node.js 22.12 or newer, and a Chromium build — either Playwright's
(`npx playwright install chromium`) or your own via `chromePath`.

Node 20 is not supported: it reached
[end of life](https://github.com/nodejs/release#release-schedule) in April 2026.

## Contributing

Bug reports, documentation fixes and focused pull requests are all welcome.

```bash
npm install
npx playwright install chromium   # only needed for the integration suite
npm run verify                    # lint + typecheck + unit tests
```

`npm run test:integration` exercises real Chromium, and `npm run test:docker` builds the image and
runs the container smoke test. Please run `npm run verify` before opening a pull request, and add a
changeset (`npx changeset`) describing the change so it makes it into a release.

## License

MIT © Luka Pozega
