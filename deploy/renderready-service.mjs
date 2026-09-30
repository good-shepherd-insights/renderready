// renderready persistent service for r780badk (per renderready's own README options)
// Renders the Streamlit app on 127.0.0.1:8504 and serves prerendered HTML on 127.0.0.1:3001.
// The UA switch (crawler -> :3001, browser -> :8504) happens in the edge router.
import { createRequire } from 'module';
const { start } = createRequire('/tmp/renderready-test/')('renderready');

const APP = 'http://127.0.0.1:8504/';

const server = await start({
  port: 3305,
  host: '0.0.0.0',
  allowedDomains: ['127.0.0.1', 'localhost', 'r780badk.marylandinsights.com', 'livefire.marylandinsights.com'],
  render: { waitAfterLastRequest: 8000, pageLoadTimeout: 30000 },
  browser: { relaunchWaitMs: 60000 },
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
});
console.log('LISTENING', server.url);
setInterval(() => {}, 1 << 30); // keep the process alive