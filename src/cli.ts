#!/usr/bin/env node
import { ConfigError, errorMessage, isRenderReadyError } from './errors.js';
import { isLogLevel, type LogLevel } from './logger.js';
import type { RenderReadyOptions } from './config.js';
import { start } from './server/createServer.js';
import { VERSION } from './version.js';

const USAGE = `renderready ${VERSION} — prerender any JavaScript web page to static HTML

Usage
  renderready [options]

Options
  -p, --port <n>        Port to listen on                     (env PORT, default 3000)
  -H, --host <addr>     Interface to bind                     (env HOST, default 0.0.0.0)
  -t, --timeout <ms>    Render budget per page                (env PAGE_LOAD_TIMEOUT, default 20000)
      --chrome <path>   Chrome/Chromium binary to use         (env CHROME_PATH)
      --allow <list>    Comma-separated domains to allow      (env ALLOWED_DOMAINS)
      --block <list>    Comma-separated domains to block      (env BLOCKED_DOMAINS)
      --log-level <l>   debug | info | warn | error | silent  (env LOG_LEVEL, default info)
      --keep-scripts    Leave <script> tags in the output
      --follow-redirects  Follow a redirect instead of returning the 3xx
  -h, --help            Show this message
  -v, --version         Show the version

Every option has an environment variable equivalent; see the README for the full
list. Command-line options take precedence.

Examples
  renderready --port 8080
  curl 'http://localhost:8080/render?url=https%3A%2F%2Fexample.com%2F'
`;

class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): {
  options: RenderReadyOptions;
  help: boolean;
  version: boolean;
} {
  const options: RenderReadyOptions = {};
  let help = false;
  let version = false;

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    // An empty string has to be rejected explicitly: `Number('')` is 0, so
    // `--port ''` would otherwise be accepted as port 0.
    if (value === undefined || value.trim() === '' || value.startsWith('-')) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  const integer = (raw: string, flag: string): number => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new UsageError(`${flag} needs an integer, received "${raw}"`);
    }
    return parsed;
  };

  const list = (raw: string): string[] =>
    raw
      .split(',')
      .map(item => item.trim())
      .filter(item => item !== '');

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-v':
      case '--version':
        version = true;
        break;
      case '-p':
      case '--port':
        options.port = integer(next(index, arg), arg);
        index++;
        break;
      case '-H':
      case '--host':
        options.host = next(index, arg);
        index++;
        break;
      case '-t':
      case '--timeout':
        options.pageLoadTimeout = integer(next(index, arg), arg);
        index++;
        break;
      case '--chrome':
        options.chromePath = next(index, arg);
        index++;
        break;
      case '--allow':
        options.allowedDomains = list(next(index, arg));
        index++;
        break;
      case '--block':
        options.blockedDomains = list(next(index, arg));
        index++;
        break;
      case '--log-level': {
        const level = next(index, arg);
        if (!isLogLevel(level)) {
          throw new UsageError(`--log-level must be one of debug, info, warn, error, silent`);
        }
        options.logLevel = level satisfies LogLevel;
        index++;
        break;
      }
      case '--keep-scripts':
        options.removeScriptTags = false;
        break;
      case '--follow-redirects':
        options.followRedirects = true;
        break;
      default:
        throw new UsageError(`Unknown option "${String(arg)}". Try --help.`);
    }
  }

  return { options, help, version };
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    console.error('\nRun `renderready --help` for usage.');
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  try {
    await start({
      ...parsed.options,
      // A browser that cannot be relaunched leaves this process unable to do the
      // one thing it exists for, so exiting is right *here* even though the
      // library itself never does it — a supervisor can restart us.
      onFatal: error => {
        console.error(error.message);
        process.exit(1);
      },
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 78; // EX_CONFIG
      return;
    }
    console.error(
      isRenderReadyError(error) ? `${error.code}: ${error.message}` : errorMessage(error),
    );
    process.exitCode = 1;
  }
}

// Not top-level await: `main` already handles its own failures and sets an exit
// code, and a top-level await would make this file unbundlable as CommonJS.
void main();
