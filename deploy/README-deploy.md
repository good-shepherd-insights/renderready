# GSI prerender deploy

- renderready-service.mjs: renderready service (one per box), renders allowed subdomains on demand
- ua-switch-proxy.mjs: UA-switch prototype - HTTP-only, NO WebSocket passthrough yet; do NOT put in front of Streamlit until upgrade handling is added
- renderready.service: systemd unit for the render service

Verified live 2026-09-30: renders 10,283 bytes (r780badk) / 15,974 bytes (livefire), stApp markup present, ~1.3s, no timeout header.
