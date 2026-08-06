---
'renderready': major
---

Initial release.

A Playwright-based prerender server you start in one line. Send it a URL over HTTP and get back the
fully rendered DOM with scripts stripped and the origin's status code preserved.

- `start()`, `createServer()` and `createRenderer()` — a server, a configurable server, or the
  render loop on its own with no HTTP layer.
- `GET /render?url=…`, `POST /render` and `GET /health`.
- Hybrid readiness: `window.renderReady` is authoritative when a page declares it, with network
  quiet as the fallback, so sites you do not control still render promptly.
- Redirects are reported rather than followed, without ever fetching the destination.
- `<meta name="renderready-status-code">` and `<meta name="renderready-header">` let a client-side
  application declare a soft 404 or a redirect its own router knows about.
- A single Chromium process with a fresh browser context per render for real cookie isolation, plus
  recycling on render count and age, and crash recovery.
- Four lifecycle hooks for caching, metrics and per-site fixups.
- Two runtime dependencies, `playwright-core` and `fastify`. Configuration validation is
  hand-written rather than schema-driven so the package adds nothing else to your install tree.
