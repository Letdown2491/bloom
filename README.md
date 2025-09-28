# Bloom
Bloom is a simple to use and intuitive file manager interface for Blossom and NIP-96 servers, alowing users to store files in a distributed way easily.

## What can Bloom do?
- **No accounts, no passwords:** Sign in with your Nostr npub via browser extension (NIP-07), or remote signer (NIP-46).
- **Stay organized:** See everything stored on each server at a glance. Want to store stuff in folders? No problem! While Blossom servers do not support this by default, Bloom leverages lists (NIP-51) to store links to blobs in a way that resembles a traditional file system.
- **Keep files safe:** Make backup copies on other servers with just a couple of clicks.
- **Keep files private:** At upload, users have the option of marking files as private which encrypts the payload with AES-GCM (NIP-44) locally before sending it to the defined servers. Note that since files are store on the user's local machine, Bloom cannot currently encrypt files that already exist on a remote server.
- **Share easily:** Grab ready-to-use links without digging through menus or share directly to Nostr by creating a note with embedded media or sending it to other users directly via DM (NIP-04) or private DM (NIP-17 encrypted via NIP-44 and sealed via NIP-59).
- **Metadata support:** Bloom fully supports editing blob metadata both at time of upload and at any point after. This is done through Nostr NIP-94 support. This allows users to "rename" blob hashes to human-readable names and add additional data for certain filetypes. Users can also set a "folder" tag on the fly. Bloom also has an option to remove EXIF metadata from images at the time of upload.
- **Media support:** Play your music right from Bloom, and with rich metadata support, actually know what you're playing. Audio files with ID3 tags will be automatically parsed and converted into metadata tags at the time of upload.
- **Connection management:** Manage your Blossom and NIP-96 servers as well as Nostr relay list (NIP-65) right from Bloom. We also support Satellite.earth's API if you use their servers for uploads.
- **Fully customizeable:** Control various UI elements right from the Settings page.

## Before You Start
- You need a browser with a Nostr extension such as Alby installed, or have a remote signer such as Amber available.

## Quick Start
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
You can build and run the production bundle inside a container without installing pnpm locally.

```bash
docker build -t bloom-app .
docker run --rm -p 3000:80 bloom-app
# open http://localhost:3000
```

### Docker Compose
```bash
docker compose up --build
# open http://localhost:3000
```

The Compose service mirrors the standalone Docker image and listens on port 3000 by default. Adjust the published port in `compose.yaml` if you need to run multiple instances side by side.
