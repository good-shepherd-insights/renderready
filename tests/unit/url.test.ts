import { describe, expect, it } from 'vitest';

import type { AccessConfig } from '../../src/config.js';
import { InvalidUrlError, UrlNotAllowedError } from '../../src/errors.js';
import { assertDomainAllowed, hostnameMatches, normalizeUrl } from '../../src/render/url.js';

const access = (overrides: Partial<AccessConfig> = {}): AccessConfig => ({
  allowedDomains: [],
  blockedDomains: [],
  basicAuth: null,
  ...overrides,
});

describe('normalizeUrl', () => {
  it('canonicalizes a valid URL', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeUrl('  https://example.com/a?b=1  ')).toBe('https://example.com/a?b=1');
  });

  it('preserves the fragment, query order and encoding', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1#frag')).toBe(
      'https://example.com/p?b=2&a=1#frag',
    );
  });

  it('keeps non-ASCII paths usable', () => {
    // URL normalization percent-encodes these; the round trip must still decode.
    const normalized = normalizeUrl('https://example.com/كاليفورنيا');
    expect(decodeURIComponent(new URL(normalized).pathname)).toBe('/كاليفورنيا');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeUrl(value)).toThrow(InvalidUrlError);
  });

  it('rejects a relative URL', () => {
    expect(() => normalizeUrl('/some/path')).toThrow(/not a valid absolute url/i);
  });

  // file: and data: would let a caller read from the renderer's own machine.
  it.each(['file:///etc/passwd', 'data:text/html,<h1>hi</h1>', 'ftp://example.com/x'])(
    'rejects the non-http scheme in %s',
    value => {
      expect(() => normalizeUrl(value)).toThrow(/only http and https/i);
    },
  );

  it('reports a 400 status on the error', () => {
    try {
      normalizeUrl('nope');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidUrlError);
      expect((error as InvalidUrlError).statusCode).toBe(400);
      expect((error as InvalidUrlError).code).toBe('INVALID_URL');
    }
  });
});

describe('hostnameMatches', () => {
  it('matches the domain itself and its subdomains', () => {
    expect(hostnameMatches('example.com', 'example.com')).toBe(true);
    expect(hostnameMatches('www.example.com', 'example.com')).toBe(true);
    expect(hostnameMatches('a.b.example.com', 'example.com')).toBe(true);
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(hostnameMatches('WWW.Example.COM', 'example.com')).toBe(true);
    expect(hostnameMatches('www.example.com.', 'example.com')).toBe(true);
    expect(hostnameMatches('www.example.com', '.example.com')).toBe(true);
  });

  // The prerender package used a substring match, so `example.com` also matched
  // `example.com.attacker.test`. That is the bug this asserts is gone.
  it('does not match a domain that merely contains the candidate', () => {
    expect(hostnameMatches('example.com.attacker.test', 'example.com')).toBe(false);
    expect(hostnameMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostnameMatches('example.community', 'example.com')).toBe(false);
  });

  it('never matches an empty candidate', () => {
    expect(hostnameMatches('example.com', '')).toBe(false);
    expect(hostnameMatches('example.com', '.')).toBe(false);
  });
});

describe('assertDomainAllowed', () => {
  it('allows anything when both lists are empty', () => {
    expect(() => assertDomainAllowed('https://anything.test/', access())).not.toThrow();
  });

  it('allows a host on the allow list', () => {
    expect(() =>
      assertDomainAllowed('https://www.example.com/', access({ allowedDomains: ['example.com'] })),
    ).not.toThrow();
  });

  it('rejects a host missing from a non-empty allow list', () => {
    expect(() =>
      assertDomainAllowed('https://other.test/', access({ allowedDomains: ['example.com'] })),
    ).toThrow(UrlNotAllowedError);
  });

  it('rejects a host on the block list', () => {
    expect(() =>
      assertDomainAllowed('https://ads.example.com/', access({ blockedDomains: ['example.com'] })),
    ).toThrow(/blocked domain/);
  });

  it('lets the block list win over the allow list', () => {
    expect(() =>
      assertDomainAllowed(
        'https://ads.example.com/',
        access({ allowedDomains: ['example.com'], blockedDomains: ['ads.example.com'] }),
      ),
    ).toThrow(UrlNotAllowedError);
  });

  it('reports a 404 status, so an excluded URL looks absent rather than forbidden', () => {
    try {
      assertDomainAllowed('https://other.test/', access({ allowedDomains: ['example.com'] }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UrlNotAllowedError).statusCode).toBe(404);
      expect((error as UrlNotAllowedError).code).toBe('URL_NOT_ALLOWED');
    }
  });
});
