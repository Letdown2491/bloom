# Bloom

Bloom is a simple to use and intuitive file manager utilizing Blossom and NIP-96 servers to store files in a distributed way. 

## What can Bloom do?
- **No accounts, no passwords:** sign in with your Nostr account.
- **Stay organized:** See everything stored on each server at a glance.
- **Keep files safe:** Make backup copies on other servers with just a few clicks.
- **Share easily:** Grab ready-to-use links without digging through menus or share directly to Nostr by creating a note with embedded media.

## Before You Start
- Use a browser that supports Nostr extensions (for example, Alby)
- Have the addresses of the Blossom servers you want to use. I have added a few popular options by default in case you don't have any preference.

## Quick Start
```bash
pnpm install
pnpm dev
# open http://localhost:5173
```

1. Open Bloom and click **Connect (NIP-07)** so your browser extension can unlock your servers.
2. Add one or more server addresses in the **Servers** panel. The server name is derived from the URL, but feel free to customize with your own.
3. Browse your files, copy links, or delete items you no longer need.
4. Head to **Upload** to drop in new photos, audio, or other media. Bloom tidies them, removes extra data, and keeps track of progress.
5. Use **Transfer** when you want to copy selected files to another server for backup.

## How It Works Behind the Scenes
- Bloom remembers your preferred servers by saving a short note to your Nostr profile. Your data is yours always.
- The app talks to Blossom and NIP-96 servers using simple web requests to list, upload, delete, or mirror files.
- Extra tools help clean images (remove hidden data, resize, generate blur previews) before they upload.

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
