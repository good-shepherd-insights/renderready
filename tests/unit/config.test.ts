import { describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN_HEADERS, resolveConfig } from '../../src/config.js';
import { ConfigError } from '../../src/errors.js';

// An explicit empty env keeps these tests independent of the ambient shell.
const NO_ENV = {};

describe('resolveConfig', () => {
  it('produces the documented defaults with no options and no env', () => {
    const config = resolveConfig({}, NO_ENV);

    expect(config.server).toEqual({ port: 3000, host: '0.0.0.0' });
    expect(config.browser).toEqual({
      chromePath: undefined,
      extraChromeArgs: [],
      blockImages: true,
      blockFonts: true,
      recycleAfterRenders: 300,
      recycleAfterMs: 600_000,
      relaunchWaitMs: 30_000,
    });
    expect(config.render.pageLoadTimeout).toBe(20_000);
    expect(config.render.pageDoneCheckInterval).toBe(500);
    expect(config.render.waitAfterLastRequest).toBe(500);
    expect(config.render.renderReadyDelay).toBe(1_000);
    expect(config.render.followRedirects).toBe(false);
    expect(config.render.timeoutStatusCode).toBeNull();
    expect(config.render.renderErrorStatusCode).toBe(504);
    expect(config.render.userAgent).toBeNull();
    expect(config.render.viewportWidth).toBe(1440);
    expect(config.render.viewportHeight).toBe(718);
    expect(config.render.originHeaders).toEqual({ 'X-RenderReady': '1' });
    expect(config.render.removeScriptTags).toBe(true);
    expect(config.render.absoluteUrls).toBe(true);
    expect(config.render.metaStatusCode).toBe(true);
    expect(config.render.injectRenderMeta).toBe(false);
    expect(config.access).toEqual({ allowedDomains: [], blockedDomains: [], basicAuth: null });
    expect(config.logLevel).toBe('info');
  });

  it('does not hand out the shared default origin-headers object', () => {
    const config = resolveConfig({}, NO_ENV);
    config.render.originHeaders['X-RenderReady'] = 'tampered';

    expect(DEFAULT_ORIGIN_HEADERS['X-RenderReady']).toBe('1');
    expect(resolveConfig({}, NO_ENV).render.originHeaders).toEqual({ 'X-RenderReady': '1' });
  });

  it('reads values from the environment', () => {
    const config = resolveConfig(
      {},
      {
        PORT: '8080',
        HOST: '127.0.0.1',
        CHROME_PATH: '/usr/bin/chromium',
        PAGE_LOAD_TIMEOUT: '5000',
        FOLLOW_REDIRECTS: 'true',
        ALLOWED_DOMAINS: 'example.com, www.example.com',
        LOG_LEVEL: 'debug',
      },
    );

    expect(config.server).toEqual({ port: 8080, host: '127.0.0.1' });
    expect(config.browser.chromePath).toBe('/usr/bin/chromium');
    expect(config.render.pageLoadTimeout).toBe(5000);
    expect(config.render.followRedirects).toBe(true);
    expect(config.access.allowedDomains).toEqual(['example.com', 'www.example.com']);
    expect(config.logLevel).toBe('debug');
  });

  it('lets options win over the environment', () => {
    const config = resolveConfig(
      { port: 4000, followRedirects: false },
      { PORT: '8080', FOLLOW_REDIRECTS: 'true' },
    );

    expect(config.server.port).toBe(4000);
    expect(config.render.followRedirects).toBe(false);
  });

  // With `option || env || default` a deliberate 0 or false silently falls
  // through to the default. We use `??`.
  it('honors falsy option values instead of falling through to defaults', () => {
    const config = resolveConfig({ waitAfterLastRequest: 0, renderReadyDelay: 0 }, NO_ENV);

    expect(config.render.waitAfterLastRequest).toBe(0);
    expect(config.render.renderReadyDelay).toBe(0);
  });

  it('treats an empty-string env var as unset', () => {
    const config = resolveConfig({}, { PORT: '   ', HOST: '' });

    expect(config.server).toEqual({ port: 3000, host: '0.0.0.0' });
  });

  it.each(['1', 'true', 'YES', 'on'])('parses %s as boolean true', value => {
    expect(resolveConfig({}, { FOLLOW_REDIRECTS: value }).render.followRedirects).toBe(true);
  });

  it.each(['0', 'false', 'NO', 'off'])('parses %s as boolean false', value => {
    expect(resolveConfig({}, { BLOCK_IMAGES: value }).browser.blockImages).toBe(false);
  });

  it('rejects a non-boolean boolean env var', () => {
    expect(() => resolveConfig({}, { FOLLOW_REDIRECTS: 'maybe' })).toThrow(ConfigError);
    expect(() => resolveConfig({}, { FOLLOW_REDIRECTS: 'maybe' })).toThrow(/must be a boolean/);
  });

  it.each(['abc', '1.5', 'Infinity'])('rejects %s as an integer env var', value => {
    expect(() => resolveConfig({}, { PORT: value })).toThrow(/must be an integer/);
  });

  it('rejects out-of-range values with a readable message', () => {
    expect(() => resolveConfig({ port: 70_000 }, NO_ENV)).toThrow(ConfigError);
    expect(() => resolveConfig({ pageLoadTimeout: 0 }, NO_ENV)).toThrow(
      /Invalid renderready configuration/,
    );
    expect(() => resolveConfig({ renderErrorStatusCode: 99 }, NO_ENV)).toThrow(ConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() => resolveConfig({}, { LOG_LEVEL: 'chatty' })).toThrow(ConfigError);
  });

  it('rejects an unknown blocked resource type', () => {
    expect(() => resolveConfig({}, { BLOCKED_RESOURCE_TYPES: 'image,unicorn' })).toThrow(
      ConfigError,
    );
  });

  it('accepts known blocked resource types from the environment', () => {
    const config = resolveConfig({}, { BLOCKED_RESOURCE_TYPES: 'image, media ,font' });

    expect(config.render.blockedResourceTypes).toEqual(['image', 'media', 'font']);
  });

  it('rejects a poll interval longer than the render timeout', () => {
    expect(() =>
      resolveConfig({ pageLoadTimeout: 1_000, pageDoneCheckInterval: 2_000 }, NO_ENV),
    ).toThrow(/must not exceed/);
  });

  describe('basic auth', () => {
    it('is null by default', () => {
      expect(resolveConfig({}, NO_ENV).access.basicAuth).toBeNull();
    });

    it('is built from both env vars', () => {
      const config = resolveConfig(
        {},
        { BASIC_AUTH_USERNAME: 'crawler', BASIC_AUTH_PASSWORD: 'secret' },
      );

      expect(config.access.basicAuth).toEqual({ username: 'crawler', password: 'secret' });
    });

    it.each([
      ['BASIC_AUTH_USERNAME', { BASIC_AUTH_USERNAME: 'crawler' }],
      ['BASIC_AUTH_PASSWORD', { BASIC_AUTH_PASSWORD: 'secret' }],
    ])('rejects %s without its counterpart', (_name, env) => {
      expect(() => resolveConfig({}, env)).toThrow(/must both be set/);
    });

    it('lets an option override the environment', () => {
      const config = resolveConfig(
        { basicAuth: { username: 'a', password: 'b' } },
        { BASIC_AUTH_USERNAME: 'crawler', BASIC_AUTH_PASSWORD: 'secret' },
      );

      expect(config.access.basicAuth).toEqual({ username: 'a', password: 'b' });
    });
  });
});
