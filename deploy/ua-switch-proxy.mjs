// UA-switch proxy for r780badk.marylandinsights.com
// Crawlers -> renderready (prerendered DOM), browsers -> Streamlit app.
// Port 8610. This is what the tunnel ingress points at.
import http from 'http';

const RENDER_URL = 'http://127.0.0.1:3305/render?url=' + encodeURIComponent('https://r780badk.marylandinsights.com/');
const APP_HOST = '127.0.0.1';
const APP_PORT = 8504;
const CRAWLER = /googlebot|bingbot|duckduckbot|baiduspider|yandexbot|sogou|slurp|facebookexternalhit|twitterbot|linkedinbot|lighthouse|bots?\b|spider|crawler|pagespeed/i;

http.createServer((req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (!CRAWLER.test(ua)) {
    // Stream original Streamlit app untouched
    const proxy = http.request({ host: APP_HOST, port: APP_PORT, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502); res.end('app upstream error'); });
    req.pipe(proxy);
    return;
  }
  // Crawler: fetch fresh prerender from renderready and serve it
  http.get(RENDER_URL, (rr) => {
    let html = '';
    rr.on('data', (c) => { html += c; });
    rr.on('end', () => {
      if (rr.statusCode !== 200 || html.length < 9500) {
        // render failed/shell: fall back to the live app rather than serve junk
        const proxy = http.request({ host: APP_HOST, port: APP_PORT, path: req.url, method: req.method, headers: req.headers }, (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        });
        proxy.on('error', () => { res.writeHead(502); res.end('render+upstream error'); });
        req.pipe(proxy);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-prerendered': 'renderready' });
      res.end(html);
    });
  }).on('error', () => { res.writeHead(502); res.end('renderready unreachable'); });
}).listen(8610, '0.0.0.0', () => console.log('UA-switch proxy on 8610'));