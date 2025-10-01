# Private Link Proxy

This microservice resolves Bloom private-link aliases and streams the underlying
Blossom object without exposing the real Blossom URL.

## Environment variables

| name | description |
| --- | --- |
| `PORT` | HTTP port (default `8787`). |
| `RELAY_URLS` | Comma‑separated list of relays to query. |
| `PRIVATE_LINK_SERVICE_SECRET` | Hex private key that matches the Bloom proxy pubkey. |
| `BLOSSOM_REQUEST_HEADERS` | Optional semicolon‑separated list of headers forwarded to Blossom (e.g. `Authorization: Bearer x;X-Custom: y`). |
| `CACHE_TTL_SECONDS` | Optional success cache time (default `60`). |

Copy `.env.example` and fill the values before starting the service.

## Installation

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

## Production build

```bash
pnpm build
pnpm start
```

Deploy the compiled `build/server.js` with the environment variables shown above.
