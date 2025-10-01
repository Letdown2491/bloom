# Bloom
Bloom is a simple to use and intuitive file manager interface for Blossom and NIP-96 servers, alowing users to store files in a distributed way easily.

## What can Bloom do?
- **No accounts, no passwords:** Sign in with your Nostr npub via browser extension (NIP-07), or remote signer (NIP-46).
- **Stay organized:** See everything stored on each server at a glance. Want to store stuff in folders? No problem! While Blossom servers do not support this by default, Bloom leverages lists (NIP-51) to store links to blobs in a way that resembles a traditional file system.
- **File searches:** Easily search for files on any connected server by name, file type, mime type, extension, or file size, or combined any search type to find exactly what you need. Bloom also has some easy to access filters for popular file types right from the toolbar.
- **Keep files safe:** Make backup copies on other servers with just a couple of clicks.
- **Keep files private:** At upload, users have the option of marking files as private which encrypts the payload with AES-GCM (NIP-44) locally before sending it to the defined servers. Note that since files are encrypted on the user's machine, Bloom cannot currently encrypt files that already exist on a remote server.
- **Share easily:** Grab ready-to-use links without digging through menus or share directly to Nostr by creating a note with embedded media or sending it to other users directly via DM (NIP-04) or private DM (NIP-17 encrypted via NIP-44 and sealed via NIP-59) without ever having to leave Bloom.
- **Share privately:** Since files are uploaded to publicly accessible servers, anyone with access to the link can access it. Bloom provides a proxy microservice so that you can create private links that obfuscate the originating URL for sharing. You can delete private links at any time and that file will no longer be accessible to anyone that has the link. Additionally, you can set optional expiration dates on links for additional control.
- **Metadata support:** Bloom fully supports editing blob metadata both at time of upload and at any point after. This is done through Nostr NIP-94 support. This allows users to "rename" blob hashes to human-readable names and add additional data for certain filetypes. Users can also set a "folder" tag on the fly. Bloom also has an option to remove EXIF metadata from images at the time of upload.
- **Media support:** Play your music right from Bloom, and with rich metadata support, actually know what you're playing. Audio files with ID3 tags will be automatically parsed and converted into metadata tags at the time of upload.
- **Connection management:** Manage your Blossom and NIP-96 servers as well as Nostr relay list (NIP-65) right from Bloom. We also support Satellite.earth's API if you use their servers for uploads.
- **Easily edit your Nostr profile:** You can edit your Nostr profile (kind-0) right from Bloom, and quickly search for avatar and banner images right from your connected servers without having to copy URLs from somewhere else.
- **Fully customizable:** Control various UI elements and more right from the Settings page. You can optionally save your settings to your preferred relay list (NIP-77) to have your settings synced across all your devices. You can leave this option disabled, but your sessions will only be saved on local storage.

## Before You Start
- You need a browser with a Nostr extension such as Alby installed, or have a remote signer such as Amber available.

## Quick Start
If you wish to set up the event proxy to serve private links (links to files without exposing the Blossom endpoints) follow the steps below. If you do not wish to serve private links, skip to the **Development Build** or **Production Build** sections further down.

## Setting up the private link proxy (Optional)

If you want to proxy private links, follow the intructions below. This is optional, but recommended.
1. Copy the .env file
```bash
cd bloom
cp .example-env.json .env
```
2. Open .env in in your favorite text editor and enter a hex formatted public key as the value for VITE_PRIVATE_LINK_SERVICE_PUBKEY.
3. Copy the .env file
```bash
cd services/private-link-proxy
cp .example-env.json .env
```
4. Open .env in in your favorite text editor and enter the hex formatted private key for your public key from step 2 in PRIVATE_LINK_SERVICE_SECRET.
5. Start the proxy
```bash
pnpm install
pnpm build
pnpm start
# The proxy will start listening at http://localhost:8787
```

## Development Build
```bash
pnpm install
pnpm dev
# open http://localhost:5173
```

## Production Build
```bash
pnpm build
pnpm preview
# open http://localhost:4173
```

## Docker
You can build and run the production bundle inside a container without installing pnpm locally. If you want to use the private link proxy, edit VITE_PRIVATE_LINK_SERVICE_PUBKEY and PRIVATE_LINK_SERVICE_SECRET in Dockerfile as per the instructions in **Setting up the private link proxy (Optional).

```bash
docker build -t bloom-app .
docker run --rm -p 3000:80 bloom-app
# open http://localhost:3000
```

### Docker Compose
If you're using the private link proxy, no additional setup is required beyond the steps in **Setting up the private link proxy (Optional).

```bash
docker compose up --build
# open http://localhost:3000
```

The Compose service mirrors the standalone Docker image and listens on port 3000 by default. Adjust the published port in `compose.yaml` if you need to run multiple instances side by side.
