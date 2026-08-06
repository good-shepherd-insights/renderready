import { describe, expect, it } from 'vitest';

import {
  BrowserLaunchError,
  BrowserUnavailableError,
  ConfigError,
  errorMessage,
  InvalidUrlError,
  isRenderReadyError,
  RenderError,
  RenderReadyError,
  UrlNotAllowedError,
} from '../../src/errors.js';

describe('error taxonomy', () => {
  it.each([
    [ConfigError, 'INVALID_CONFIG', undefined],
    [InvalidUrlError, 'INVALID_URL', 400],
    [UrlNotAllowedError, 'URL_NOT_ALLOWED', 404],
    [BrowserUnavailableError, 'BROWSER_UNAVAILABLE', 503],
    [BrowserLaunchError, 'BROWSER_LAUNCH_FAILED', undefined],
    [RenderError, 'RENDER_FAILED', undefined],
  ])('$name carries its code and intrinsic status', (Ctor, code, statusCode) => {
    const error = new Ctor('boom');

    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
    expect(error.message).toBe('boom');
  });

  it('names each error after its own class, so stacks and logs read correctly', () => {
    expect(new RenderError('x').name).toBe('RenderError');
    expect(new BrowserUnavailableError('x').name).toBe('BrowserUnavailableError');
  });

  it('extends Error and the shared base', () => {
    const error = new RenderError('x');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RenderReadyError);
  });

  it('preserves a cause', () => {
    const cause = new Error('underlying');

    expect(new RenderError('wrapper', { cause }).cause).toBe(cause);
    expect(new BrowserUnavailableError('wrapper', { cause }).cause).toBe(cause);
  });

  it('leaves cause undefined when none is given', () => {
    expect(new RenderError('x').cause).toBeUndefined();
  });
});

describe('isRenderReadyError', () => {
  it('recognizes our errors and nothing else', () => {
    expect(isRenderReadyError(new RenderError('x'))).toBe(true);
    expect(isRenderReadyError(new Error('x'))).toBe(false);
    expect(isRenderReadyError('x')).toBe(false);
    expect(isRenderReadyError(null)).toBe(false);
  });
});

describe('errorMessage', () => {
  it('reads the message off an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it.each([
    ['a string', 'boom', 'boom'],
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('stringifies %s', (_label, value, expected) => {
    expect(errorMessage(value)).toBe(expected);
  });
});
