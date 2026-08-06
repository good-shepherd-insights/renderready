import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli.js';

describe('parseArgs', () => {
  it('returns empty options for no arguments', () => {
    expect(parseArgs([])).toEqual({ options: {}, help: false, version: false });
  });

  it.each([
    ['-h', 'help'],
    ['--help', 'help'],
    ['-v', 'version'],
    ['--version', 'version'],
  ])('recognizes %s', (flag, key) => {
    expect(parseArgs([flag])[key as 'help' | 'version']).toBe(true);
  });

  it.each([
    [['-p', '8080'], { port: 8080 }],
    [['--port', '8080'], { port: 8080 }],
    [['-H', '127.0.0.1'], { host: '127.0.0.1' }],
    [['--host', '127.0.0.1'], { host: '127.0.0.1' }],
    [['-t', '5000'], { pageLoadTimeout: 5000 }],
    [['--timeout', '5000'], { pageLoadTimeout: 5000 }],
    [['--chrome', '/usr/bin/chromium'], { chromePath: '/usr/bin/chromium' }],
    [['--log-level', 'debug'], { logLevel: 'debug' }],
    [['--keep-scripts'], { removeScriptTags: false }],
    [['--follow-redirects'], { followRedirects: true }],
  ])('maps %s', (argv, expected) => {
    expect(parseArgs(argv).options).toEqual(expected);
  });

  it('parses comma-separated domain lists', () => {
    const { options } = parseArgs(['--allow', 'a.test, b.test', '--block', 'c.test']);

    expect(options.allowedDomains).toEqual(['a.test', 'b.test']);
    expect(options.blockedDomains).toEqual(['c.test']);
  });

  it('combines several options', () => {
    const { options } = parseArgs(['--port', '8080', '--keep-scripts', '--log-level', 'warn']);

    expect(options).toEqual({ port: 8080, removeScriptTags: false, logLevel: 'warn' });
  });

  it.each([['--port'], ['--host'], ['--timeout'], ['--chrome'], ['--allow'], ['--log-level']])(
    'rejects %s with no value',
    flag => {
      expect(() => parseArgs([flag])).toThrow(/needs a value/);
    },
  );

  // Otherwise `--port --host x` would silently read "--host" as the port.
  it('does not consume a following flag as a value', () => {
    expect(() => parseArgs(['--port', '--host'])).toThrow(/needs a value/);
  });

  it.each([['abc'], ['1.5'], ['']])('rejects a non-integer port %s', value => {
    expect(() => parseArgs(['--port', value])).toThrow(/needs a/);
  });

  it('rejects an unknown log level', () => {
    expect(() => parseArgs(['--log-level', 'chatty'])).toThrow(/--log-level must be one of/);
  });

  it('rejects an unknown option and points at --help', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option "--nope".*--help/s);
  });
});
