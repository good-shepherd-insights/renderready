# Migrating from Rendertron

[GoogleChrome/rendertron](https://github.com/GoogleChrome/rendertron) was archived in October 2022
and hasn't had a commit since. This is a bigger migration than moving off `prerender/prerender` —
Rendertron's API shape is different in a few places — but the core behaviour you're relying on
carries over directly.

## The request

Rendertron embeds the target URL in the path. renderready uses a query parameter:

```diff
- GET /render/https://example.com/products/1
+ GET /render?url=https%3A%2F%2Fexample.com%2Fproducts%2F1
```

This is the change every caller needs to make — a reverse-proxy rewrite rule, middleware
configuration, or whatever issues the render request has to switch from path-embedding to
query-encoding the URL. There's no way to make the query form accept a raw, unencoded URL in the
path; `?` and `&` inside the target URL would otherwise be ambiguous with the request's own query
string.

`?mobile` did two things: it set mobile viewport dimensions and switched Rendertron's own
User-Agent to a mobile string. The dimensions map to a `width`/`height` override on the request
(or `viewportWidth`/`viewportHeight` if you run separately-configured instances for mobile and
desktop); the User-Agent swap maps to the `userAgent` override — set it explicitly if your app
does UA-sniffing to decide what markup or styles to serve, since changing the viewport size alone
won't trigger that logic.

## Readiness — this is the good news

Rendertron never had a page-side readiness signal. Its renderer "waits for the page load event and
for outstanding network requests to settle" — full stop. There's no equivalent of a custom flag
your app can set.

renderready's network-quiet fallback is a direct behavioural match for this — it's what Rendertron
was already doing. **You don't have to change your application at all to get equivalent behaviour.**
`window.renderReady` is available if you _want_ apps to be able to cut a render short once they know
they're done, which Rendertron's approach never let you do, but adopting it is optional, not
required for migration.

## Status codes

Rendertron preserves the origin's status code, same as renderready. The soft-status meta tag
differs in both name and separator:

```diff
- <meta name="render:status_code" content="404" />
+ <meta name="renderready-status-code" content="404" />
```

Rendertron has no documented equivalent of a header-injection meta tag (renderready's
`renderready-header`, for declaring things like a redirect `Location` from the page). If you were
working around that gap some other way, `renderready-header` may let you remove the workaround.

## Caching

Rendertron shipped three built-in cache backends — in-memory, filesystem, and Google Cloud
Datastore — with configurable TTL and entry limits.

**renderready has no built-in cache**, deliberately: what to key on, how long to keep an entry, and
where to store it are decisions specific to your traffic, and an HTTP cache in front of the service
(a CDN, Varnish, nginx) is usually a better answer than anything baked into the renderer. See
[Adding a cache](../README.md#adding-a-cache) for the two hooks you need to build your own —
`onRequest` to check a cache before rendering, `onPageLoaded` to write to it after.

If you were using Rendertron's `GET /invalidate/<url>` to bust the cache, you'll need to replace it
with a purge call against whatever you put in front — a CDN purge API, or clearing your own cache
store directly.

## What's gone

- **Screenshots** (`GET /screenshot/<url>`). Out of scope for v1 — Playwright makes this
  straightforward to add on top of `createRenderer()` if you need it.
- **The `wc-inject-shadydom` query parameter.** Rendertron used this to force a ShadyDOM polyfill
  for older Web Components v1 implementations. There's no equivalent flag in renderready; modern
  Chromium (which is what Playwright drives) has broad native support for web components without
  it in most cases.

## Configuration

Rendertron is configured through a `config.json` file, with only `PORT` and `HOST` overridable by
environment variable. renderready takes every option as either a constructor argument or an
environment variable — see the [README options tables](../README.md#options). There's no config
file format to translate; map your `config.json` values to the equivalent option names directly.

The one Rendertron option with no renderready counterpart is `restrictedUrlPattern` (a regex
blocklist on the request path). The nearest equivalents are `blockedDomains` and
`blockedUrlPatterns`, though the latter matches against the target URL rather than the incoming
request path.

## Browser installation

Rendertron bundled Puppeteer, which downloads its own Chromium automatically on `npm install`.
renderready uses `playwright-core`, which doesn't — install the browser explicitly:

```bash
npx playwright install chromium
```

This keeps the package install small; it costs you one extra command.

## Checklist

- [ ] Change every caller from `GET /render/<url>` to `GET /render?url=<encoded>`.
- [ ] If you relied on `?mobile`, configure `viewportWidth`/`viewportHeight` or pass per-request
      `width`/`height` overrides instead.
- [ ] Rename any `render:status_code` meta tags to `renderready-status-code`.
- [ ] Replace Rendertron's built-in cache with an HTTP cache in front of the service, or wire up
      `onRequest`/`onPageLoaded` — see [Adding a cache](../README.md#adding-a-cache).
- [ ] Replace any use of `GET /invalidate/<url>` with a purge against whatever now sits in front.
- [ ] Run `npx playwright install chromium` — the browser is no longer bundled automatically.
- [ ] Drop `wc-inject-shadydom` from any request URLs; there's no equivalent flag.
