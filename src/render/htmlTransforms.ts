/**
 * HTML post-processing.
 *
 * These are pure string transforms — no browser, no DOM, no framework — which
 * makes them cheap to test exhaustively.
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

/** Any `<meta>` tag. Attributes are parsed separately rather than in one pattern. */
const META_TAG = /<meta\b[^>]*>/gi;

/** One `name="value"` attribute, accepting double, single, or no quotes. */
const ATTRIBUTE = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const STATUS_CODE_DIRECTIVE = 'renderready-status-code';
const HEADER_DIRECTIVE = 'renderready-header';

/**
 * Strip `<script>` tags, preserving `application/ld+json` structured data —
 * that is content search engines consume, not behaviour.
 *
 * Also removes `<link rel="import">`, which can pull in further scripts.
 *
 * A single regex pass with a replacer function, deliberately: looping over
 * `String.match()` results and calling `content.replace(match, '')` per match
 * looks equivalent but is not — `replace` with a string argument only replaces
 * the first occurrence, so duplicate identical script blocks survive.
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
  /** From `<meta name="renderready-status-code">`, if present and valid. */
  statusCode?: number;
  /** From every `<meta name="renderready-header" content="Key: Value">`. */
  headers: Record<string, string>;
  /** The HTML with those meta tags removed. */
  html: string;
}

/** Parse a tag's attributes into a lower-cased name to raw-value map. */
function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  // A fresh instance per call: a module-level global regex carries `lastIndex`
  // between calls, which would make results depend on call order.
  const pattern = new RegExp(ATTRIBUTE.source, ATTRIBUTE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (name !== undefined && !attributes.has(name)) {
      attributes.set(name, value);
    }
  }
  return attributes;
}

/**
 * Extract and strip the `renderready-status-code` / `renderready-header` meta tags.
 *
 * This is how a client-side application reports a soft 404, or a redirect that
 * only its own router knows about — the server has no other way to learn that
 * `/products/does-not-exist` should not be indexed.
 *
 * Attributes are parsed properly rather than matched with one large alternating
 * pattern, so attribute order and quoting style fall out for free instead of
 * needing a branch each.
 *
 * Only the `<head>` is scanned, so body content that happens to look like one of
 * these tags cannot spoof a status code.
 */
export function extractMetaDirectives(html: string): MetaDirectives {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);

  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  const consumed: string[] = [];

  const tags = new RegExp(META_TAG.source, META_TAG.flags);
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(head)) !== null) {
    const attributes = parseAttributes(tag[0]);
    const name = attributes.get('name');
    const content = attributes.get('content');
    if (content === undefined) {
      continue;
    }

    if (name === STATUS_CODE_DIRECTIVE) {
      // First one wins; a later tag cannot override an earlier decision.
      if (statusCode === undefined) {
        const parsed = Number(content);
        if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
          statusCode = parsed;
        }
      }
      consumed.push(tag[0]);
      continue;
    }

    if (name === HEADER_DIRECTIVE) {
      const separator = content.indexOf(':');
      if (separator > 0) {
        const headerName = content.slice(0, separator).trim();
        const headerValue = content.slice(separator + 1).trim();
        if (headerName !== '') {
          headers[headerName] = decodeHtmlEntities(headerValue);
        }
      }
      consumed.push(tag[0]);
    }
  }

  let result = html;
  for (const directive of consumed) {
    result = result.replace(directive, '');
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
  /** Present only when a `renderready-status-code` meta tag asked for one. */
  statusCode?: number;
  /** Headers requested via `renderready-header` meta tags. */
  headers: Record<string, string>;
}

/**
 * Run the enabled transforms in a deliberate order: meta directives first, so a
 * directive can never be removed as collateral damage when scripts go; then
 * scripts; then URL rewriting; then provenance tags last, so nothing downstream
 * strips them back out.
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
