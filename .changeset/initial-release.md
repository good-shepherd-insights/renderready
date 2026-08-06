---
'renderready': minor
---

Initial release.

A Playwright-based prerender server you start in one line. Send it a URL over HTTP and get back the
fully rendered DOM with scripts stripped and the origin's status code preserved.

- `start()`, `createServer()` and `createRenderer()` — a server, a configurable server, or the
  render loop on its own with no HTTP layer.
- `GET /render?url=…`, `POST /render` and `GET /health`.
- Hybrid readiness: `window.prerenderReady` is authoritative when a page declares it, with network
  quiet as the fallback, so sites you do not control still render promptly.
- Redirects are reported rather than followed, without ever fetching the destination.
- `<meta name="prerender-status-code">` and `<meta name="prerender-header">` are honored, so an
  application already instrumented for the `prerender` package works unchanged.
- A single Chromium process with a fresh browser context per render for real cookie isolation, plus
  recycling on render count and age, and crash recovery.
- Four lifecycle hooks for caching, metrics and per-site fixups.
