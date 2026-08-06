import { describe, expect, it } from 'vitest';

import {
  absolutizeUrls,
  applyHtmlTransforms,
  decodeHtmlEntities,
  extractMetaDirectives,
  injectRenderMeta,
  removeScriptTags,
  type HtmlTransformOptions,
} from '../../src/render/htmlTransforms.js';

const ALL_OFF: HtmlTransformOptions = {
  removeScriptTags: false,
  absoluteUrls: false,
  metaStatusCode: false,
  injectRenderMeta: false,
};

describe('removeScriptTags', () => {
  it('removes a plain script tag', () => {
    expect(removeScriptTags('<p>a</p><script>doStuff()</script><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });

  it('removes scripts with attributes and src', () => {
    expect(removeScriptTags('<script src="/app.js" defer></script>x')).toBe('x');
  });

  it('removes multiline scripts', () => {
    expect(removeScriptTags('a<script>\nlet x = 1;\n// </notascript>\n</script>b')).toBe('ab');
  });

  it('removes several distinct scripts', () => {
    expect(removeScriptTags('<script>a()</script>mid<script>b()</script>')).toBe('mid');
  });

  // The implementation this replaces looped over match results calling
  // content.replace(match, ''), which only removes the FIRST occurrence of an
  // identical string per iteration — so duplicated script blocks survived.
  it('removes every occurrence of an identical script block', () => {
    const duplicated = '<script>same()</script>A<script>same()</script>B<script>same()</script>';

    expect(removeScriptTags(duplicated)).toBe('AB');
  });

  it('preserves application/ld+json structured data', () => {
    const html =
      '<script type="application/ld+json">{"@type":"Article"}</script><script>x()</script>';

    expect(removeScriptTags(html)).toBe(
      '<script type="application/ld+json">{"@type":"Article"}</script>',
    );
  });

  it('preserves ld+json regardless of attribute order and quoting', () => {
    const html = `<script id="sd" type='application/ld+json'>{}</script>`;

    expect(removeScriptTags(html)).toBe(html);
  });

  // The ld+json check must look only at the opening tag; a script *body* that
  // mentions the mime type is still executable code and must go.
  it('does not keep a normal script whose body merely mentions ld+json', () => {
    const html = '<script>var t = "application/ld+json";</script>';

    expect(removeScriptTags(html)).toBe('');
  });

  it('removes self-closing script tags', () => {
    expect(removeScriptTags('a<script src="/x.js"/>b')).toBe('ab');
  });

  it('removes link rel=import tags', () => {
    expect(removeScriptTags('<link rel="import" href="/c.html">x')).toBe('x');
  });

  // The previous regex lacked the `g` flag, so only the first import was removed
  // despite looping over the matches.
  it('removes every link rel=import tag, not just the first', () => {
    const html = '<link rel="import" href="/a.html"><link rel="import" href="/b.html">keep';

    expect(removeScriptTags(html)).toBe('keep');
  });

  it('leaves unrelated link tags alone', () => {
    const html = '<link rel="stylesheet" href="/a.css">';

    expect(removeScriptTags(html)).toBe(html);
  });

  it('is a no-op on HTML with no scripts', () => {
    expect(removeScriptTags('<p>plain</p>')).toBe('<p>plain</p>');
  });
});

describe('absolutizeUrls', () => {
  it('rewrites root-relative src and href', () => {
    const html = '<img src="/a.png"><a href="/about">x</a>';

    expect(absolutizeUrls(html, 'https://example.com/page')).toBe(
      '<img src="https://example.com/a.png"><a href="https://example.com/about">x</a>',
    );
  });

  it('uses the origin, not the full page URL', () => {
    expect(absolutizeUrls('<img src="/a.png">', 'https://example.com/deep/path?q=1')).toBe(
      '<img src="https://example.com/a.png">',
    );
  });

  it('preserves the original quote style', () => {
    expect(absolutizeUrls(`<img src='/a.png'>`, 'https://e.test/')).toBe(
      `<img src='https://e.test/a.png'>`,
    );
  });

  it('handles a non-default port', () => {
    expect(absolutizeUrls('<img src="/a.png">', 'http://localhost:8080/x')).toBe(
      '<img src="http://localhost:8080/a.png">',
    );
  });

  it('leaves absolute URLs untouched', () => {
    const html = '<img src="https://cdn.test/a.png"><a href="http://o.test/b">x</a>';

    expect(absolutizeUrls(html, 'https://example.com/')).toBe(html);
  });

  // `//host/path` already resolves against the current scheme; rewriting it
  // would produce `https://example.com///host/path`.
  it('leaves protocol-relative URLs untouched', () => {
    const html = '<img src="//cdn.test/a.png">';

    expect(absolutizeUrls(html, 'https://example.com/')).toBe(html);
  });

  it('leaves document-relative URLs untouched', () => {
    const html = '<img src="a.png"><a href="./b">x</a>';

    expect(absolutizeUrls(html, 'https://example.com/')).toBe(html);
  });

  it('leaves fragment and non-http hrefs untouched', () => {
    const html = '<a href="#top">t</a><a href="mailto:a@b.test">m</a>';

    expect(absolutizeUrls(html, 'https://example.com/')).toBe(html);
  });

  it('does not touch attributes that merely end in src or href', () => {
    const html = '<div data-src="/a.png"></div>';

    expect(absolutizeUrls(html, 'https://example.com/')).toBe(html);
  });

  it('rewrites a bare root path to the origin root', () => {
    expect(absolutizeUrls('<a href="/">home</a>', 'https://example.com/x')).toBe(
      '<a href="https://example.com/">home</a>',
    );
  });
});

describe('extractMetaDirectives', () => {
  it('reads and strips a status code', () => {
    const html =
      '<html><head><meta name="renderready-status-code" content="404"></head><body>x</body></html>';
    const result = extractMetaDirectives(html);

    expect(result.statusCode).toBe(404);
    expect(result.html).not.toContain('renderready-status-code');
    expect(result.html).toContain('<body>x</body>');
  });

  it('reads the tag with attributes in the reverse order', () => {
    const html = '<head><meta content="410" name="renderready-status-code"></head>';

    expect(extractMetaDirectives(html).statusCode).toBe(410);
  });

  it('reads and strips headers', () => {
    const html =
      '<head><meta name="renderready-header" content="Location: https://example.com/new"></head>';
    const result = extractMetaDirectives(html);

    expect(result.headers).toEqual({ Location: 'https://example.com/new' });
    expect(result.html).not.toContain('renderready-header');
  });

  it('reads several headers', () => {
    const html =
      '<head>' +
      '<meta name="renderready-header" content="Location: /a">' +
      '<meta name="renderready-header" content="X-Thing: b">' +
      '</head>';

    expect(extractMetaDirectives(html).headers).toEqual({ Location: '/a', 'X-Thing': 'b' });
  });

  it('decodes entities in header values', () => {
    const html = '<head><meta name="renderready-header" content="Location: /a?x=1&amp;y=2"></head>';

    expect(extractMetaDirectives(html).headers.Location).toBe('/a?x=1&y=2');
  });

  it('reads a status code and headers together, the redirect case', () => {
    const html =
      '<head>' +
      '<meta name="renderready-status-code" content="302">' +
      '<meta name="renderready-header" content="Location: https://example.com/new">' +
      '</head>';
    const result = extractMetaDirectives(html);

    expect(result.statusCode).toBe(302);
    expect(result.headers).toEqual({ Location: 'https://example.com/new' });
    expect(result.html).toBe('<head></head>');
  });

  // Body content must not be able to spoof a status code.
  it('ignores directives that appear after </head>', () => {
    const html = '<head></head><body><meta name="renderready-status-code" content="500"></body>';
    const result = extractMetaDirectives(html);

    expect(result.statusCode).toBeUndefined();
    expect(result.html).toBe(html);
  });

  it('reports no status code when there is no tag', () => {
    const result = extractMetaDirectives('<head><title>t</title></head>');

    expect(result.statusCode).toBeUndefined();
    expect(result.headers).toEqual({});
  });

  it('ignores a status code outside the valid HTTP range but still strips the tag', () => {
    const result = extractMetaDirectives(
      '<head><meta name="renderready-status-code" content="999"></head>',
    );

    expect(result.statusCode).toBeUndefined();
    expect(result.html).not.toContain('renderready-status-code');
  });

  it('handles HTML with no head at all', () => {
    const html = '<meta name="renderready-status-code" content="404">body';

    expect(extractMetaDirectives(html).statusCode).toBe(404);
  });

  // A module-level global regex keeps `lastIndex` between calls; the
  // implementation clones it per call so repeated use stays correct.
  it('is stable across repeated calls', () => {
    const html = '<head><meta name="renderready-header" content="A: 1"></head>';

    expect(extractMetaDirectives(html).headers).toEqual({ A: '1' });
    expect(extractMetaDirectives(html).headers).toEqual({ A: '1' });
    expect(extractMetaDirectives(html).headers).toEqual({ A: '1' });
  });
});

describe('decodeHtmlEntities', () => {
  it.each([
    ['&amp;', '&'],
    ['&lt;a&gt;', '<a>'],
    ['&quot;q&quot;', '"q"'],
    ['&apos;', "'"],
    ['&#39;', "'"],
    ['&#x27;', "'"],
    ['&#65;', 'A'],
    ['&#x41;', 'A'],
  ])('decodes %s', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it('leaves unknown entities alone', () => {
    expect(decodeHtmlEntities('&notreal;')).toBe('&notreal;');
  });

  it('leaves an out-of-range code point alone', () => {
    expect(decodeHtmlEntities('&#x110000;')).toBe('&#x110000;');
  });

  it('passes through text with no entities', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });
});

describe('injectRenderMeta', () => {
  const meta = { renderId: 'abc-123', renderedAt: new Date('2026-01-02T03:04:05.000Z') };

  it('inserts provenance tags before </head>', () => {
    const result = injectRenderMeta(
      '<html><head><title>t</title></head><body></body></html>',
      meta,
    );

    expect(result).toContain('<meta name="x-renderready-render-id" content="abc-123">');
    expect(result).toContain(
      '<meta name="x-renderready-render-at" content="2026-01-02T03:04:05.000Z">',
    );
    expect(result.indexOf('x-renderready-render-id')).toBeLessThan(result.indexOf('</head>'));
  });

  it('is a no-op when there is no head', () => {
    expect(injectRenderMeta('<p>x</p>', meta)).toBe('<p>x</p>');
  });

  it('escapes the render id so it cannot break out of the attribute', () => {
    const result = injectRenderMeta('<head></head>', {
      ...meta,
      renderId: '"><script>evil()</script>',
    });

    expect(result).not.toContain('<script>evil()');
    expect(result).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('applyHtmlTransforms', () => {
  const html =
    '<html><head>' +
    '<meta name="renderready-status-code" content="404">' +
    '<script>app()</script>' +
    '<script type="application/ld+json">{"a":1}</script>' +
    '</head><body><img src="/a.png"></body></html>';

  it('runs every enabled transform', () => {
    const result = applyHtmlTransforms(html, 'https://example.com/p', {
      removeScriptTags: true,
      absoluteUrls: true,
      metaStatusCode: true,
      injectRenderMeta: false,
    });

    expect(result.statusCode).toBe(404);
    expect(result.html).not.toContain('renderready-status-code');
    expect(result.html).not.toContain('app()');
    expect(result.html).toContain('application/ld+json');
    expect(result.html).toContain('src="https://example.com/a.png"');
  });

  it('does nothing when every transform is disabled', () => {
    const result = applyHtmlTransforms(html, 'https://example.com/p', ALL_OFF);

    expect(result.html).toBe(html);
    expect(result.statusCode).toBeUndefined();
    expect(result.headers).toEqual({});
  });

  it('leaves the status code unread when metaStatusCode is off', () => {
    const result = applyHtmlTransforms(html, 'https://example.com/p', {
      ...ALL_OFF,
      removeScriptTags: true,
    });

    expect(result.statusCode).toBeUndefined();
    expect(result.html).toContain('renderready-status-code');
  });

  // Directives are read before scripts are stripped, so a directive can never be
  // removed as collateral damage.
  it('reads a directive that sits inside the region scripts occupy', () => {
    const withScriptAround =
      '<head><script>a()</script><meta name="renderready-status-code" content="410"></head>';
    const result = applyHtmlTransforms(withScriptAround, 'https://example.com/', {
      removeScriptTags: true,
      absoluteUrls: false,
      metaStatusCode: true,
      injectRenderMeta: false,
    });

    expect(result.statusCode).toBe(410);
    expect(result.html).toBe('<head></head>');
  });

  it('injects provenance tags only when asked and given metadata', () => {
    const options: HtmlTransformOptions = { ...ALL_OFF, injectRenderMeta: true };
    const meta = { renderId: 'r1', renderedAt: new Date('2026-01-01T00:00:00.000Z') };

    expect(applyHtmlTransforms('<head></head>', 'https://e.test/', options, meta).html).toContain(
      'x-renderready-render-id',
    );
    expect(applyHtmlTransforms('<head></head>', 'https://e.test/', options).html).toBe(
      '<head></head>',
    );
  });

  it('returns the headers requested by meta tags', () => {
    const result = applyHtmlTransforms(
      '<head><meta name="renderready-header" content="X-A: 1"></head>',
      'https://e.test/',
      { ...ALL_OFF, metaStatusCode: true },
    );

    expect(result.headers).toEqual({ 'X-A': '1' });
  });
});
