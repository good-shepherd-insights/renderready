# GSI prerender deploy

## Components
- renderready-service.mjs - renderready server (renders allowed subdomains on demand). Service-level values (port, allowedDomains) live in its own config section; see renderready.conf.json for the canonical set. It binds 127.0.0.1 in production; only ua-switch talks to it.
- ua-switch.mjs - production UA switch. Every operational value is read from ua-switch.conf.json: port, bind, crawlerRegex, render urlTemplate/timeoutMs/headers, appsFile path. Zero literals in code. WebSocket upgrades pass raw to the app; only plain HTTP crawler GETs go to renderready.
- ua-switch-apps.json - hostname-to-target map referenced by conf.appsFile. Adding an app: append one entry, restart switch, no code change.
- renderready.service - systemd unit (Restart=always, network start dependency).

Routing model:

| Request | Path | Response |
|---|---|---|
| crawler UA (regex from conf) | switch -> renderready /render | prerendered HTML, origin status code |
| human UA / WebSocket upgrade | switch -> app raw | live app untouched |
| unknown host | switch | 404 from appsFile miss |

## Operational values policy
No addresses, ports, domains, regexes, or timeouts appear in code. The two JSON files plus the systemd unit are the only places they exist. Code reads: UA_SWITCH_CONF env var or the file adjacent to the module.

## Verification protocol
Each behavior verified live per rules in the PR body:
- crawler path: response marked by renderready render id, no timed-out header
- human path: byte-for-byte pass-through, WebSocket 101 plus streamed frames
- unknown host: 404

## Rules
- prerendered content must equal live-app content (no cloaking)
- renderready must never be reachable except from ua-switch
- app fan-out is Host-header based: appsFile, not code