# Bloom

Bloom is a simple to use and intuitive file manager utilizing Blossom and NIP-96 servers to store files in a distributed way. 

## What Bloom Helps You Do
- **Save time:** Add a server once, then reuse it whenever you upload or copy files.
- **Stay organized:** See everything stored on each server at a glance.
- **Keep files safe:** Make backup copies on other servers with just a few clicks.
- **Share easily:** Grab ready-to-use links without digging through menus.

## Before You Start
- Use a browser that supports Nostr extensions (for example, Alby). This is the "key" that unlocks your lockers.
- Have the addresses of the Blossom servers you want to use.

## Quick Start
```bash
pnpm install
pnpm dev
# open http://localhost:5173
```

1. Open Bloom and click **Connect (NIP-07)** so your browser extension can unlock your servers.
2. Add one or more server addresses in the **Servers** panel. Turn on **Requires auth** if the server expects a sign-in header. This is checked by default.
3. Browse your files, copy links, or delete items you no longer need.
4. Head to **Upload** to drop in new photos, audio, or other media. Bloom tidies them, removes extra data, and keeps track of progress.
5. Use **Transfer** when you want to copy selected files to another server for backup.

## How It Works Behind the Scenes (Only if You're Curious)
- Bloom remembers your preferred servers by saving a short note to your Nostr profile. That way your setup can travel with you.
- The app talks to Blossom and NIP-96 servers using simple web requests to list, upload, delete, or mirror files.
- Extra tools help clean images (remove hidden data, resize, generate blur previews) before they upload.

## Production Build
```bash
pnpm build
pnpm preview
```

## What Could Come Next
- Richer media previews, like playlists or video thumbnails.
- Health checks so you know when a server is running out of space.
- Drag-and-drop desktop helper for big batches of files.
