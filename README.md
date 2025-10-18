## What is Bloom?

**Bloom** is an intuitive, privacy-focused file manager for **Blossom** and **NIP-96** servers. It lets you store, organize, and share files across the distributed Nostr ecosystem with no passwords required.

## What can Bloom do?

- **Simple Sign-In:** Sign in instantly with your Nostr npub using a browser extension (NIP-07) or a remote signer (NIP-46).
- **Organized Storage:** View all your files across connected servers at a glance. Create folder-like structures using lists (NIP-51) so you can organize blobs as if you were in a traditional file system.
- **Smart Search:** Find anything by name, file type, MIME type, extension, or size. Bloom includes quick filters for common file types right in the toolbar.
- **Backup and Safety:** Replicate your files to other servers with just a few clicks to ensure they’re never lost.
- **Private by Design:** Encrypt files locally using AES-GCM (NIP-44) before upload. Please note that Bloom cannot retroactively encrypt files that already exist on a remote server.
- **Easy Sharing:** Generate shareable links or post directly to Nostr as public notes, DMs (NIP-04), or private DMs (NIP-17 + NIP-59) without leaving Bloom.
- **Private Links:** Use Bloom’s optional proxy microservice to hide server URLs and create expiring or revocable private links.
- **Folder Sharing:** Make folders public so anyone can view and download contents without logging in, using NIP-19 events.
- **Metadata and File Info:** Edit file metadata anytime via NIP-94. Rename blobs, tag folders, or strip EXIF data from images on upload.
- **Built-in Media Support:** Play audio directly in Bloom. Files with ID3 tags are automatically parsed into readable metadata.
- **Connection Management:** Easily manage your Blossom and NIP-96 media servers, and Nostr relay (NIP-65) connections.
- **Profile Editing:** Edit your Nostr profile (kind-0) from within Bloom, and quickly choose avatars or banners from your connected servers.
- **Customization and Sync:** Personalize your interface and settings. Optionally sync preferences across devices using NIP-77, or keep them local for privacy.

### Search syntax

Use the global search bar to combine natural text with structured keywords:

- `not:` excludes matches (`blink not:image` skips image MIME types, `not:genre:jazz` removes jazz metadata).
- `server:` and `folder:` scope results to specific hosts or folder paths (`server:nostr`, `folder:photos/trips`).
- `is:` accepts flags such as `audio`, `image`, `video`, `document`, `pdf`, `private`, and `shared`.
- `size:` keeps supporting comparisons and ranges (`size:>50mb`, `size:10mb...200mb`).
- Relative time tokens work with `before:`, `after:`, and `on:` – try `before:-7d`, `after:-24h`, `on:today`, or `on:yesterday`.
- `duration:` checks audio length using the same comparison syntax as size (`duration:>3m`, `duration:2m...6m`).
- `year:` now understands numeric comparisons and ranges (`year:>=1990`, `year:1990...1999`).
- `before:`, `after:`, and `on:` filter by upload time using `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` (`after:2024-01`, `on:2023-05-10`).
- Combine everything freely; Bloom normalizes tokens to lowercase so `NOT:` and `server:` behave the same regardless of casing.

## Before You Start
- You need a browser with a Nostr extension such as Alby installed, or have a remote signer such as Amber available.

## Quick Start
If you wish to set up the event proxy to serve private links (links to files without exposing the Blossom endpoints) follow the steps below. If you do not wish to serve private links, skip to the **Development Build** or **Production Build** sections further down.

### Setting up the private link proxy (Optional)

If you want to proxy private links, follow the instructions below. This is optional, but recommended.

1. Copy the Bloom env template:
   ```bash
   cp .env-example .env
   ```
2. Edit `.env` and set:
   - `VITE_PRIVATE_LINK_SERVICE_PUBKEY` to the hex public key that will publish private link aliases.
   - `VITE_PRIVATE_LINK_SERVICE_HOST` to the URL where the proxy will be reachable (defaults to `http://localhost:8787`).
3. Copy the proxy env template:
   ```bash
   cd services/private-link-proxy
   cp .env.example .env
   ```
4. Edit `services/private-link-proxy/.env` and configure the service:
   - `PRIVATE_LINK_SERVICE_SECRET` must be the hex private key that matches the public key from step 2.
   - `RELAY_URLS` should list the relays (comma-separated) Bloom uses to resolve aliases.
   - Optional overrides: `PORT` (proxy listen port), `BLOSSOM_REQUEST_HEADERS` (forwarded headers such as auth tokens), `CACHE_TTL_SECONDS`.
5. While still in `services/private-link-proxy`, install dependencies and start the proxy:
   ```bash
   pnpm install
   pnpm build
   pnpm start
   # The proxy will start listening at http://localhost:8787 by default. 
   # Change this to the domain you will be using to serve proxy links. 
   # We recommend using a subdomain such as https://private.mydomain.com
   ```

### Development Build
```bash
pnpm install
pnpm dev
# open http://localhost:5173
```

### Production Build
```bash
pnpm build
pnpm preview
# open http://localhost:4173
```

### Docker
You can build and run the production bundle inside a container without installing pnpm locally. Provide the proxy values as build arguments (replace them inline or export them in your shell) before running the container.

```bash
docker build \
  --build-arg VITE_PRIVATE_LINK_SERVICE_HOST=${VITE_PRIVATE_LINK_SERVICE_HOST:-CHANGE_THIS_BEFORE_BUILDING \
  --build-arg VITE_PRIVATE_LINK_SERVICE_PUBKEY=${VITE_PRIVATE_LINK_SERVICE_PUBKEY:-CHANGE_THIS_BEFORE_BUILDING} \
  -t bloom-web .
docker run --rm -p 3000:80 bloom-web
# open http://localhost:3000
```

To run the private link proxy alongside the web container, build the proxy stage and supply the environment file you configured in **Setting up the private link proxy (Optional)**:

```bash
docker build --target private-link-proxy -t bloom-private-link-proxy .
docker run --rm --env-file services/private-link-proxy/.env -p 8787:8787 bloom-private-link-proxy
```

### Docker Compose
Docker Compose builds both containers with your `.env` values and starts them together. Make sure `.env` and `services/private-link-proxy/.env` exist from the earlier setup steps before running the command below.

```bash
docker compose up --build
# open http://localhost:3000
```

The `web` service publishes port 80 to `3000` by default. Override `PRIVATE_LINK_PROXY_PORT` in your environment if you need the proxy on a different host port.
