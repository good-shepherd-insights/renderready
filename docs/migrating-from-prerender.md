# Migrating from `prerender/prerender`

As of this writing, [`prerender/prerender`](https://github.com/prerender/prerender) returns a 404 —
the source repository is gone. The [npm package](https://www.npmjs.com/package/prerender) still
resolves and installs (last published 2024-09-12), so existing deployments and fresh installs both
keep working. What you lose is a path to a fix: no repository means no security patches, and no fix
for the one crash-recovery gap in its own design — if Chrome dies twice within a second of each
other, the old server calls `process.exit()` and depends on an external supervisor to bring it back,
with no retry loop of its own. Its browser recycling is otherwise reasonable: it restarts an idle
browser automatically, and restarts on a fixed schedule too if you use the documented `server.js`
entry point (or register the `browserForceRestart` plugin yourself on a custom build).

The good news: renderready is behaviour-compatible with almost everything the old server did. Most
migrations are a URL change and an environment-variable rename, not an application rewrite.

## The request

The old server answered two shapes: `GET /<url>` (the whole path _was_ the target URL — used by
`prerender-node` and friends) and `GET|POST /render?url=…` (the crawler API). renderready only
answers the second:

```diff
- GET /http://localhost:8000/products/1
+ GET /render?url=http%3A%2F%2Flocalhost%3A8000%2Fproducts%2F1
```

If you're using a middleware package (`prerender-node`, `prerender_rails`, `Laravel-Prerender`),
check whether it can be pointed at `/render?url=` directly, or whether you need a thin proxy in
front that rewrites the catch-all form into a query parameter. The catch-all is gone on purpose —
it made every malformed request look like a render attempt.

## The readiness flag

Unchanged in behaviour, renamed:

```diff
- window.prerenderReady = false;
+ window.renderReady = false;
```

Same semantics: define it as a boolean and it becomes authoritative — nothing is captured until it
turns `true`. Once it does, capture happens as soon as the network goes quiet or
`renderReadyDelay` (was `prerenderReadyDelay`) elapses, whichever comes first. If you never define
it, nothing changes: network-quiet still handles it.

## Meta tags

```diff
- <meta name="prerender-status-code" content="404" />
+ <meta name="renderready-status-code" content="404" />

- <meta name="prerender-header" content="Location: https://example.com/new" />
+ <meta name="renderready-header" content="Location: https://example.com/new" />
```

Both are read from `<head>` only and stripped from the output, same as before.

## Headers

The old server sent `X-Prerender: 1` to your origin so your app could detect the crawler. renderready
sends `X-RenderReady: 1` by default (configurable via `originHeaders`). If you have server-side logic
branching on that header, it needs the new name.

Response-side: `x-prerender-504-reason` is now `x-renderready-error`, and `x-prerender-render-id` /
`x-prerender-render-at` (from the `addMetaTags` plugin) are `x-renderready-render-id` /
`x-renderready-render-at`, opt-in via `injectRenderMeta` rather than a plugin you register.

## Environment variables

Most names are unchanged. The ones that moved:

| Old                           | New                        |
| ----------------------------- | -------------------------- |
| `CHROME_LOCATION`             | `CHROME_PATH`              |
| `RENDERING_ERROR_STATUS_CODE` | `RENDER_ERROR_STATUS_CODE` |
| `PRERENDER_READY_DELAY`\*     | `RENDER_READY_DELAY`       |

\* the old server didn't have this env var; only the `prerenderReadyDelay` option existed. Its
environment-variable form is new.

`PORT`, `WAIT_AFTER_LAST_REQUEST`, `PAGE_DONE_CHECK_INTERVAL`, `PAGE_LOAD_TIMEOUT`,
`FOLLOW_REDIRECTS`, `TIMEOUT_STATUS_CODE`, `ALLOWED_DOMAINS`, `BASIC_AUTH_USERNAME`,
`BASIC_AUTH_PASSWORD` all mean exactly what they did.

## Plugins → config flags and hooks

The old server used a `server.use(plugin)` system with nine bundled plugins. renderready folds the
common ones into options — see the [README options tables](../README.md#options) for the full
list — and gives you [four hooks](../README.md#hooks) for the rest.

| Plugin                  | renderready equivalent                                                |
| ----------------------- | --------------------------------------------------------------------- |
| `whitelist`/`blacklist` | `allowedDomains` / `blockedDomains`                                   |
| `basicAuth`             | `basicAuth` option                                                    |
| `removeScriptTags`      | `removeScriptTags` option, `true` by default (was opt-in)             |
| `httpHeaders`           | `metaStatusCode` option, `true` by default (was opt-in)               |
| `addMetaTags`           | `injectRenderMeta` option, `false` by default                         |
| `sendPrerenderHeader`   | `originHeaders`, on by default                                        |
| `blockResources`        | `blockedResourceTypes` / `blockedUrlPatterns`                         |
| `browserForceRestart`   | `recycleAfterMs` (age-based recycling is on by default, not opt-in)   |
| in-memory / S3 cache    | no built-in cache — see [Adding a cache](../README.md#adding-a-cache) |

The two behavioural defaults worth double-checking: script stripping and meta-directive handling
were things you had to register a plugin for; in renderready they're on unless you turn them off.

## What's gone

- **`renderType=png|jpeg|pdf|har`.** HTML only. If you depended on the screenshot or PDF endpoints,
  there's currently no replacement — Playwright makes them straightforward to add on top of
  `createRenderer()` if you need to fork or wrap.
- **`_escaped_fragment_` query handling.** Google retired the AJAX crawling scheme in 2015; nothing
  currently depends on it.
- **HAR file export.**

## Chrome installation

The old server expected Chrome to already be on the machine, at a hardcoded path per platform (and
`chromeLocation` to override it). renderready uses Playwright, which manages its own browser:

```bash
npx playwright install chromium
```

`chromePath` / `CHROME_PATH` still let you point at a system Chrome instead.

## Checklist

- [ ] Point middleware or reverse-proxy rules at `/render?url=` instead of the catch-all path.
- [ ] Rename `window.prerenderReady` → `window.renderReady` in any app that sets it (skip if you
      never set it — network-quiet is unaffected).
- [ ] Rename `prerender-status-code` / `prerender-header` meta tags.
- [ ] Update any code branching on the `X-Prerender` request header or `x-prerender-*` response
      headers.
- [ ] Rename `CHROME_LOCATION` → `CHROME_PATH` and `RENDERING_ERROR_STATUS_CODE` →
      `RENDER_ERROR_STATUS_CODE` in your environment.
- [ ] Run `npx playwright install chromium` instead of relying on a system Chrome install.
- [ ] If you used `blockResources`, `browserForceRestart`, or a cache plugin, read the
      corresponding option/section above — behaviour is similar but the defaults differ.
