# Installing Cards as a permanent app on macOS

You're done with `npm run dev`. Cards now runs as a background service that auto-starts at login, served at a stable URL, with a real dock icon you click like any native app.

## What's already set up

- **Production build** at `.next/` (run `npm run build` to refresh after code changes).
- **launchd service** at `~/Library/LaunchAgents/com.philosopher-king.cards.plist`. Loaded and running. It starts `next start -p 3737` at login and restarts the process if it ever crashes.
- **Logs** at `~/Library/Logs/cards-app.{out,err}.log`.

## Install as a dock app (one-time)

1. Open Chrome (or Edge, Brave, Arc — anything Chromium-based).
2. Go to **http://localhost:3737**.
3. In the URL bar on the right, click the **Install Cards** icon (a small "+" or computer-with-arrow icon).
   - If you don't see it: ⋮ menu → **Cast, save, and share** → **Install Cards**.
4. Confirm. Cards opens as a standalone window with no browser chrome and pins itself to your dock.
5. Right-click the dock icon → **Options** → **Keep in Dock** so it stays there permanently.

**Safari (macOS 14+):** open the URL → File → **Add to Dock**.

## Daily use

- Click the dock icon. The app opens instantly because the service is already running.
- Quitting the window doesn't kill the service. Reopening is instant.
- Reboot? The service comes back up automatically.

## When you change code

```bash
cd /Users/bwv988/Philosopher-King/CARDS/V1/app
npm run build
launchctl kickstart -k gui/$(id -u)/com.philosopher-king.cards
```

`kickstart -k` cleanly stops the old `next start` and starts a new one with the freshly built code. The dock icon needs no changes.

## Service operations

```bash
# Status
launchctl print gui/$(id -u)/com.philosopher-king.cards

# Stop temporarily (until next login or manual start)
launchctl bootout gui/$(id -u)/com.philosopher-king.cards

# Start again after a bootout
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.philosopher-king.cards.plist

# Tail the live log
tail -f ~/Library/Logs/cards-app.out.log
```

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.philosopher-king.cards
rm ~/Library/LaunchAgents/com.philosopher-king.cards.plist
rm -f ~/Library/Logs/cards-app.{out,err}.log
```

Then in Chrome: ⋮ → **Apps** → right-click Cards → **Remove from Chrome**. Your local data (decks, cards, review history) lives in IndexedDB and stays untouched until you wipe it from Chrome's site settings.

## Why not Tauri / Electron / a real .app bundle?

Tauri (~5MB) and Electron (~150MB) each wrap the same web code in a native shell. They produce a draggable `.app` you put in `/Applications`. The trade-off:

- **Pro:** no localhost dependency, real macOS code-signing, easier distribution.
- **Con:** requires migrating all dynamic Next.js routes (`/deck/[id]`, `/study/[deckId]`, `/note/[id]`) to query-param / hash-based routing because static export can't handle dynamic params without prerendering. ~half-day refactor.

The launchd approach above gets you the UX (dock icon, no terminal, auto-start, instant launch) without that refactor. If you ever want to ship Cards to other people, that's when Tauri starts paying for itself.

## Troubleshooting

**Dock icon launches Chrome instead of a standalone window.**
The PWA install didn't take. Open `chrome://apps`. If Cards isn't there, repeat the install step from a fresh tab — the install button only appears when the manifest validates and the service worker is alive (give it a couple of seconds after first load).

**Port 3737 is taken.**
Edit the plist's `<string>3737</string>` to something else (3838, 4747, …), update `package.json`'s `start:prod` script to match, then:

```bash
launchctl bootout gui/$(id -u)/com.philosopher-king.cards
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.philosopher-king.cards.plist
```

You'll need to reinstall the PWA from the new URL, since Chrome ties an installed app to its origin.

**Service keeps respawning fast (`KeepAlive` looping).**
`tail ~/Library/Logs/cards-app.err.log`. Most often this is a build that didn't run since a code change, or a port conflict. Run `npm run build` then `launchctl kickstart -k gui/$(id -u)/com.philosopher-king.cards`.
