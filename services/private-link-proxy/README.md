## Private Link Proxy

This microservice resolves Bloom private-link aliases and streams the underlying
Blossom object without exposing the real Blossom URL.

### Environment variables

| name | description |
| --- | --- |
| `PORT` | HTTP port (default `8787`). Change this to the domain you will be using to serve proxy links. We recommend using a subdomain such as https://private.mydomain.com  |
| `RELAY_URLS` | Comma‑separated list of relays to query. The default here is fine. |
| `PRIVATE_LINK_SERVICE_SECRET` | Hex private key that matches the Bloom proxy pubkey. Make sure it is in hex and not npub format.  |
| `BLOSSOM_REQUEST_HEADERS` | Optional semicolon‑separated list of headers forwarded to Blossom (e.g. `Authorization: Bearer x;X-Custom: y`). The default here is fine. |
| `CACHE_TTL_SECONDS` | Optional success cache time (default `60`). |

Copy `.env.example` to `.env` and fill the values before starting the service.

### Installation

```bash
pnpm install
```

### Development

```bash
pnpm dev
```

### Production build

```bash
pnpm build
pnpm start
```

Deploy the compiled `build/server.js` with the environment variables shown above.