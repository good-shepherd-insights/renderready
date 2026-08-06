import { describe, expect, it, vi } from 'vitest';

import { createConsoleLogger, isLogLevel, noopLogger } from '../../src/logger.js';

function captureConsole() {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    stdout: () => out.mock.calls.map(call => String(call[0])),
    stderr: () => err.mock.calls.map(call => String(call[0])),
  };
}

describe('createConsoleLogger', () => {
  it('writes info and debug to stdout, warn and error to stderr', () => {
    const console_ = captureConsole();
    const logger = createConsoleLogger('debug');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(console_.stdout()).toHaveLength(2);
    expect(console_.stderr()).toHaveLength(2);
  });

  it('suppresses anything below the threshold', () => {
    const console_ = captureConsole();
    const logger = createConsoleLogger('warn');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');

    expect(console_.stdout()).toEqual([]);
    expect(console_.stderr()).toHaveLength(1);
  });

  it('emits nothing at all when silent', () => {
    const console_ = captureConsole();
    const logger = createConsoleLogger('silent');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(console_.stdout()).toEqual([]);
    expect(console_.stderr()).toEqual([]);
  });

  it('defaults to info', () => {
    const console_ = captureConsole();
    const logger = createConsoleLogger();

    logger.debug('hidden');
    logger.info('shown');

    expect(console_.stdout()).toHaveLength(1);
    expect(console_.stdout()[0]).toContain('shown');
  });

  it('includes an ISO timestamp, the level and the package name', () => {
    const console_ = captureConsole();

    createConsoleLogger('info').info('hello');

    expect(console_.stdout()[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO {2}renderready hello$/);
  });

  it('appends metadata as key=value pairs', () => {
    const console_ = captureConsole();

    createConsoleLogger('info').info('rendered', { url: 'https://a.test/', ms: 12, ok: true });

    expect(console_.stdout()[0]).toContain('url="https://a.test/" ms=12 ok=true');
  });

  it('skips undefined metadata values and empty metadata', () => {
    const console_ = captureConsole();
    const logger = createConsoleLogger('info');

    logger.info('a', { keep: 1, drop: undefined });
    logger.info('b', {});

    expect(console_.stdout()[0]).toContain('a keep=1');
    expect(console_.stdout()[0]).not.toContain('drop');
    expect(console_.stdout()[1]).toMatch(/renderready b$/);
  });

  it('reduces an Error value to its message', () => {
    const console_ = captureConsole();

    createConsoleLogger('info').error('failed', { err: new Error('boom') });

    expect(console_.stderr()[0]).toContain('err="boom"');
  });

  it('survives a value that cannot be serialized', () => {
    const console_ = captureConsole();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    createConsoleLogger('info').info('cyclic', { circular });

    expect(console_.stdout()[0]).toContain('circular="[unserializable]"');
  });
});

describe('noopLogger', () => {
  it('discards everything without touching the console', () => {
    const console_ = captureConsole();

    noopLogger.debug('d');
    noopLogger.info('i');
    noopLogger.warn('w');
    noopLogger.error('e');

    expect(console_.stdout()).toEqual([]);
    expect(console_.stderr()).toEqual([]);
  });
});

describe('isLogLevel', () => {
  it.each(['debug', 'info', 'warn', 'error', 'silent'])('accepts %s', value => {
    expect(isLogLevel(value)).toBe(true);
  });

  it.each(['DEBUG', 'trace', '', null, undefined, 3])('rejects %s', value => {
    expect(isLogLevel(value)).toBe(false);
  });
});
