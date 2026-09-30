// renderready persistent service - renders allowed subdomains on demand.
// All operational values from renderready.conf.json (README: options are programmatic or env).
// The prerenderReady window bridge is optional (conf.bridge) - only needed for origins
// that signal readiness on prerenderReady instead of renderReady.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const { start } = createRequire('/tmp/renderready-test/')('renderready');

const HERE = dirname(fileURLToPath(import.meta.url));
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