# GSI prerender deploy

## Components
- renderready-service.mjs - renderready server (renders allowed subdomains on demand). Config: host/port/allowedDomains in file constants.
- ua-switch.mjs - production UA switch. Config in ua-switch.conf.json (port, bind, crawlerRegex, render URL template, appsFile path mapping hostname->host:port). WebSocket upgrades pass raw to the app; only plain HTTP crawler GETs go to renderready.
- ua-switch-apps.json - hostname -> host:port map (add one line per app; no code change).
- renderready.service - systemd unit.

## Verified 2026-09-30 (real curl probes, live)
- Browser UA via public URL: 200, 7,260 B (live shell untouched)
- Googlebot UA via public URL: 200, 10,283 B, stApp x8, 1.5s (prerendered DOM)
- WebSocket through public URL: 101 Switching Protocols + 200 B first frame via UA-switch
- Direct UA-switch probes: crawler 10,283 B / browser 7,260 B / WS 101

## Rules
- prerendered content must equal live-app content (no cloaking)
- renderready binds 127.0.0.1 only in production; only ua-switch talks to it
- app fan-out is Host-header based: appsFile, not code
