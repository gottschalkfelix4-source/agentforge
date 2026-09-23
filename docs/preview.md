# Live preview (internal browser)

The preview panel shows dev servers running inside a workspace container (Vite, Next.js, …) in an
iframe, with console capture and HMR.

## Data path

```
browser iframe ──► app preview listener ──► wsd  /proxy/<port>/<path>  ──► 127.0.0.1:<port> (or [::1])
 (slot cookie)      (auth, header rewrite,     (bearer token, streams        inside the workspace
                     HTML script injection)      HTTP + raw WebSocket pipe)
```

* **Slots** – `POST /api/projects/:id/previews {port}` returns a `PreviewSlot` (reuses the slot for the same
  project+port, otherwise a free one, otherwise the least recently used one is evicted). Slots live in memory;
  after a server restart the browser simply requests them again. `GET /api/projects/:id/previews`,
  `DELETE /api/previews/:slot`. Changes publish `previews.changed` on `project:<id>`.
* **Auth** – the first request must carry `?__vibe_pv=<token>` (one-time, 60 s, bound to the slot). The proxy
  answers `302` to the same URL without the parameter and sets `vibe_pv_<slot>` (HttpOnly, HMAC-signed with a
  per-process secret, bound to slot + project + port, valid 12 h). Requests without a valid cookie get a small
  401 page that also tells the panel (`postMessage` `auth-required`) to fetch a fresh token.
* **Forwarding** – `vibe_session` and all `vibe_pv_*` cookies are stripped, `Host` becomes `localhost:<port>`
  (Vite `allowedHosts`), `Origin`/`Referer` of the preview origin are rewritten to `http://localhost:<port>`,
  `X-Forwarded-Host/Proto/For` are set. A browser `Authorization` header travels as `X-Vibe-Authorization` and is
  restored by wsd (the real header carries the wsd bearer token). Upstream `Set-Cookie`s named like the app's own
  cookies are dropped.
* **Injection** – for HTML navigations the proxy asks upstream for `Accept-Encoding: identity` and inserts
  `<script src="/__vibe/inject.js">` right after `<head>` (fallbacks: after `<html>`, after the doctype, at the
  start). It streams: only the bytes up to the insertion point are buffered. Compressed HTML is passed through
  without injection. `Content-Length` is dropped when injecting. `X-Frame-Options` and CSP `frame-ancestors`
  are removed; a CSP `script-src` (or `default-src`) gets `'self'` added if needed.
  `/__vibe/inject.js` is served by the proxy itself and posts `PreviewMessage`s (console, errors, navigation)
  to the parent window, and obeys `PreviewCommand`s (reload/back/forward).
* **WebSockets** (Vite/Next HMR) are piped raw end to end after the cookie check.

## Modes

### Port mode (default)

The app listens on `PREVIEW_PORT_START … PREVIEW_PORT_START + PREVIEW_PORT_COUNT - 1` (default 7100–7119),
one port per slot, on the same `HOST` as the main server. The iframe loads
`<same scheme>://<same hostname as the app>:<hostPort>/…`.

**Docker:** the range must be published next to the app port. `docker/compose.yml` and the Unraid template
already publish `7100-7119`. If you change `PREVIEW_PORT_START`/`PREVIEW_PORT_COUNT`, change the published range
too. Ports that cannot be bound are logged and skipped.

### Subdomain mode

```
PREVIEW_MODE=subdomain
PREVIEW_DOMAIN=preview.example.com
```

Needs wildcard DNS (`*.preview.example.com`) pointing at the app and a reverse proxy that forwards those hosts
(with WebSocket upgrades and `X-Forwarded-Proto`) to the main app port. Requests whose `Host` is
`p<slot>.preview.example.com` are handled by the preview proxy before any app route; everything else is the
normal app. `PreviewSlot.origin` is `https://p<slot>.preview.example.com` (scheme from the request to the API).
For local tests `PREVIEW_DOMAIN=preview.localhost:8787` works (browsers resolve `*.localhost`).

## Security notes / limitations

* In **port mode** the preview runs on the same hostname as the app (different port). Browsers treat that as the
  same *site*: the preview's JavaScript cannot read the app (different origin), `vibe_session` is HttpOnly and is
  stripped by the proxy, and app API writes need the `X-Vibe` header (CORS-preflighted, so cross-origin requests
  are rejected). Still, cookies are not isolated by port. For untrusted code prefer **subdomain mode** on a
  separate registrable domain.
* When the app is served over HTTPS by a reverse proxy, port mode would need TLS on the preview ports as well
  (mixed content is blocked). Use subdomain mode behind TLS.
* If the preview domain is a different *site* than the app, the slot cookie is set `SameSite=None; Secure`
  (HTTPS only); browsers that block third-party cookies may then refuse it.
* Slots are in memory; a server restart invalidates open previews – the panel reloads them automatically.
* Only HTML documents get the helper script; `navigate` updates therefore come from HTML pages / SPAs.
* Back/forward use the frame's own `history`; the URL bar shows the in-app path.
