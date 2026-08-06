/**
 * HTML post-processing.
 *
 * These are pure string transforms — no browser, no DOM, no framework — which
 * makes them cheap to test exhaustively. They replace the prerender package's
 * `removeScriptTags` and `httpHeaders` plugins.
 *
 * Regex-on-HTML is normally a mistake, but it is the right tool here: the input
 * is already-serialized output from a real browser engine (so it is well-formed),
 * and the alternative — reparsing megabytes of DOM in Node just to delete script
 * tags — would cost more than the render itself.
 */

/** `<script>` blocks, non-greedy, tolerating attributes and newlines. */
const SCRIPT_TAG = /<script(?:\s[^>]*)?>[\s\S]*?<\/script\s*>/gi;

/** Self-closing `<script ... />`, which browsers emit for some frameworks. */
const SELF_CLOSING_SCRIPT = /<script(?:\s[^>]*?)?\/>/gi;

/** `<link rel="import">`, which can pull in further scripts. */
const LINK_IMPORT = /<link[^>]+?rel=["']?import["']?[^>]*?>/gi;

/**
 * Root-relative `src`/`href` attribute values.
 *
 * The lookbehind rejects `data-src` and similar: `\b` would match there, because
 * `-` to `s` is a word boundary. `(?!\/)` leaves protocol-relative `//host` alone.
 */
const ROOT_RELATIVE_ATTR = /(?<![-\w])(src|href)=(["'])\/(?!\/)([^"']*)\2/gi;

const STATUS_CODE_META =
  /<meta[^<>]*(?:name=["']prerender-status-code["'][^<>]*content=["'](\d{3})["']|content=["'](\d{3})["'][^<>]*name=["']prerender-status-code["'])[^<>]*>/i;

const HEADER_META =
  /<meta[^<>]*(?:name=["']prerender-header["'][^<>]*content=["']([^"']*?): ?([^"']*?)["']|content=["']([^"']*?): ?([^"']*?)["'][^<>]*name=["']prerender-header["'])[^<>]*>/gi;

/**
 * Strip `<script>` tags, preserving `application/ld+json` structured data —
 * that is content search engines consume, not behaviour.
 *
 * Also removes `<link rel="import">`.
 *
 * Fixes two bugs in the implementation this replaces, which looped over
 * `String.match()` results and called `content.replace(match, '')` per match:
 * duplicate identical script blocks only lost their first occurrence, and the
 * `<link rel="import">` regex was missing its `g` flag so only the first was
 * ever removed. A single regex pass with a replacer function has neither
 * problem.
 */
export function removeScriptTags(html: string): string {
  return html
    .replace(SCRIPT_TAG, match => (isStructuredData(match) ? match : ''))
    .replace(SELF_CLOSING_SCRIPT, '')
    .replace(LINK_IMPORT, '');
}

function isStructuredData(scriptTag: string): boolean {
  const openTagEnd = scriptTag.indexOf('>');
  const openTag = openTagEnd === -1 ? scriptTag : scriptTag.slice(0, openTagEnd);
  return /type=["']?application\/ld\+json/i.test(openTag);
}

/**
 * Rewrite root-relative `src`/`href` values to absolute URLs against `origin`.
 *
 * Needed because the rendered HTML is usually served from a different host than
 * the page it came from, which would otherwise break every relative asset.
 * Protocol-relative `//host/path` is left alone — it already resolves.
 */
export function absolutizeUrls(html: string, pageUrl: string): string {
  const { origin } = new URL(pageUrl);
  return html.replace(
    ROOT_RELATIVE_ATTR,
    (_match, attr: string, quote: string, path: string) =>
      `${attr}=${quote}${origin}/${path}${quote}`,
  );
}

export interface MetaDirectives {
  /** From `<meta name="prerender-status-code">`, if present and valid. */
  statusCode?: number;
  /** From every `<meta name="prerender-header" content="Key: Value">`. */
  headers: Record<string, string>;
  /** The HTML with those meta tags removed. */
  html: string;
}

/**
 * Extract and strip the `prerender-status-code` / `prerender-header` meta tags.
 *
 * This is how a client-side app reports a soft 404 or a redirect that only its
 * router knows about. Kept on the `prerender-` prefix rather than renamed, so
 * existing applications work against this server unchanged.
 *
 * Only the `<head>` is scanned, so body content that happens to look like one of
 * these tags cannot spoof a status code.
 */
export function extractMetaDirectives(html: string): MetaDirectives {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);

  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  let result = html;

  const statusMatch = STATUS_CODE_META.exec(head);
  if (statusMatch) {
    const raw = statusMatch[1] ?? statusMatch[2];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
      statusCode = parsed;
    }
    result = result.replace(statusMatch[0], '');
  }

  // `exec` in a loop needs its own regex instance: HEADER_META is a module-level
  // global regex, so a shared `lastIndex` would leak between calls.
  const headerPattern = new RegExp(HEADER_META.source, HEADER_META.flags);
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerPattern.exec(head)) !== null) {
    const name = headerMatch[1] ?? headerMatch[3];
    const value = headerMatch[2] ?? headerMatch[4];
    if (name !== undefined && name !== '' && value !== undefined) {
      headers[name] = decodeHtmlEntities(value);
    }
    result = result.replace(headerMatch[0], '');
  }

  return statusCode === undefined
    ? { headers, html: result }
    : { statusCode, headers, html: result };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  nbsp: ' ',
};

/**
 * Decode the handful of entities that realistically appear in a meta `content`
 * attribute. A header value is a short ASCII string — a full entity table (and a
 * dependency to carry it) buys nothing here.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    if (named !== undefined) {
      return named;
    }
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : safeFromCodePoint(code, match);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : safeFromCodePoint(code, match);
    }
    return match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Inject provenance meta tags so a cached page can be traced back to the render
 * that produced it. Off by default — it mutates the output.
 */
export function injectRenderMeta(
  html: string,
  meta: { renderId: string; renderedAt: Date },
): string {
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd === -1) {
    return html;
  }
  const tags =
    `<meta name="x-renderready-render-id" content="${escapeAttribute(meta.renderId)}">` +
    `<meta name="x-renderready-render-at" content="${meta.renderedAt.toISOString()}">`;
  return html.slice(0, headEnd) + tags + html.slice(headEnd);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface HtmlTransformOptions {
  removeScriptTags: boolean;
  absoluteUrls: boolean;
  metaStatusCode: boolean;
  injectRenderMeta: boolean;
}

export interface HtmlTransformResult {
  html: string;
  /** Present only when a `prerender-status-code` meta tag asked for one. */
  statusCode?: number;
  /** Headers requested via `prerender-header` meta tags. */
  headers: Record<string, string>;
}

/**
 * Run the enabled transforms in the order the prerender package fired its
 * `pageLoaded` plugins: meta directives are read before scripts are stripped
 * (so a `<script>` can't hide a directive from us), then scripts, then URLs,
 * then provenance tags last so they survive untouched.
 */
export function applyHtmlTransforms(
  html: string,
  pageUrl: string,
  options: HtmlTransformOptions,
  meta?: { renderId: string; renderedAt: Date },
): HtmlTransformResult {
  let result = html;
  let statusCode: number | undefined;
  let headers: Record<string, string> = {};

  if (options.metaStatusCode) {
    const directives = extractMetaDirectives(result);
    result = directives.html;
    statusCode = directives.statusCode;
    headers = directives.headers;
  }

  if (options.removeScriptTags) {
    result = removeScriptTags(result);
  }

  if (options.absoluteUrls) {
    result = absolutizeUrls(result, pageUrl);
  }

  if (options.injectRenderMeta && meta) {
    result = injectRenderMeta(result, meta);
  }

  return statusCode === undefined
    ? { html: result, headers }
    : { html: result, statusCode, headers };
}
