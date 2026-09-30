// UA-switch: routes crawler traffic to renderready, humans straight to the app.
// Lean + config-driven: every address comes from ua-switch.conf.json (no literals below).
// App fan-out is by Host header via apps.json map - one instance serves every subdomain.
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(readFileSync(process.env.UA_SWITCH_CONF || `${HERE}/ua-switch.conf.json`, 'utf8'));
const apps = JSON.parse(readFileSync(conf.appsFile, 'utf8'));

const CRAWLER = new RegExp(conf.crawlerRegex, 'i');

// Single fan-out helper: proxy a request (or upgrade) to its target host:port raw.
function pipeTo(upstreamHost, upstreamPort, req, res) {
  const proxy = http.request({ host: upstreamHost, port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  proxy.on('error', () => { res.writeHead(502); res.end('upstream error'); });
  req.pipe(proxy);
}

function prerender(host, res) {
  const url = conf.render.urlTemplate.replace('{host}', host);
  http.get(url, { headers: conf.render.headers }, (rr) => {
    let size = 0;
    const chunks = [];
    rr.on('data', (c) => { chunks.push(c); size += c.length; });
    rr.on('end', () => {
      if (rr.statusCode !== 200) { res.writeHead(rr.statusCode); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(Buffer.concat(chunks));
    });
  }).on('error', () => { res.writeHead(502); res.end('renderready unreachable'); });
}

const server = http.createServer((req, res) => {
  const ua = req.headers['user-agent'] || '';
  const host = (req.headers.host || '').split(':')[0];
  const target = apps[host];
  if (!target) { res.writeHead(404); return res.end('unknown host'); }
  // Browsers pass through untouched (fast path)
  if (!CRAWLER.test(ua)) return pipeTo(target.host, target.port, req, res);
  // crawlers only ever issue plain GETs - no upgrade concerns on this branch
  prerender(host, res);
});

// WebSocket passthrough: upgrade requests NEVER go to renderready, always raw to the app
server.on('upgrade', (req, socket, head) => {
  const host = (req.headers.host || '').split(':')[0];
  const target = apps[host];
  if (!target) { socket.destroy(); return; }
  const proxy = http.request({
    host: target.host, port: target.port,
    path: req.url, method: req.method, headers: req.headers,
  });
  proxy.on('upgrade', (upRes, upSocket, upHead) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'
    );
    if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  proxy.on('error', () => socket.destroy());
  proxy.end();
});

server.listen(conf.port, conf.bind, () => console.log(`ua-switch on ${conf.bind}:${conf.port}`));
