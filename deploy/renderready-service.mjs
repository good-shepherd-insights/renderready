// renderready persistent service - renders allowed subdomains on demand.
// All operational values from renderready.conf.json (README: options are programmatic or env).
// The prerenderReady window bridge is optional (conf.bridge) - only needed for origins
// that signal readiness on prerenderReady instead of renderReady.
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));

// The renderready package lives on disk, not in tmpfs. Resolution order:
// RENDERREADY_PKG_DIR, then <repo>/pkg, then the legacy /tmp path. Never
// depend on tmpfs alone: a reboot wipes it and the unit crash-loops on an
// unresolvable require.
const PKG_CANDIDATES = [
  process.env.RENDERREADY_PKG_DIR,
  join(HERE, '..', 'pkg'),
  '/tmp/renderready-test',
].filter(Boolean);
const PKG_DIR = PKG_CANDIDATES.find((dir) => existsSync(join(dir, 'node_modules', 'renderready')));
if (!PKG_DIR) {
  console.error(
    `FATAL: renderready package not found. Looked in:\n${PKG_CANDIDATES.join('\n')}\n` +
    'Set RENDERREADY_PKG_DIR or restore <repo>/pkg (npm install renderready@^1.0.0).'
  );
  process.exit(1);
}
const { start } = createRequire(join(PKG_DIR, 'package.json'))('renderready');
console.log('PKG_DIR', PKG_DIR);

const conf = JSON.parse(readFileSync(process.env.RENDERREADY_CONF || join(HERE, 'renderready.conf.json'), 'utf8'));

const options = {
  port: conf.port,
  host: conf.host,
  allowedDomains: conf.allowedDomains,
  ...(conf.waitAfterLastRequest !== undefined ? { waitAfterLastRequest: conf.waitAfterLastRequest } : {}),
  ...(conf.pageLoadTimeout !== undefined ? { pageLoadTimeout: conf.pageLoadTimeout } : {}),
  ...(conf.browserRelaunchWaitMs !== undefined ? { browser: { relaunchWaitMs: conf.browserRelaunchWaitMs } } : {}),
  ...(conf.bridge
    ? {
        hooks: {
          onPageCreated: (page) => page.addInitScript(() => {
            const sync = () => { window.renderReady = window.prerenderReady === true; };
            sync();
            Object.defineProperty(window, 'prerenderReady', {
              get() { return this.__prerenderReady; },
              set(v) { this.__prerenderReady = v; window.renderReady = v === true; },
              configurable: true
            });
          })
        },
      }
    : {}),
};

const server = await start(options);
console.log('LISTENING', server.url);
setInterval(() => {}, 1 << 30); // keep the process alive