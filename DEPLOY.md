# Deploying Cards to rebuilding-iran.com/cards

The app runs as a Docker container on the same Hetzner VPS as the
rebuilding-iran site, sharing its Caddy reverse proxy. Caddy routes
`rebuilding-iran.com/cards/*` → the `cards` container's port 3000.

## One-time setup

### 1. GitHub repo

Create a new private repo (any name, e.g. `cards`) under your GitHub
account. From this directory:

```bash
cd ~/Philosopher-King/CARDS/V1/app
git init
git add .
git commit -m "Initial Cards commit"
git branch -M main
git remote add origin git@github.com:YOUR-USER/YOUR-REPO.git
git push -u origin main
```

### 2. Hetzner box: clone + initial build

SSH into the Hetzner VPS:

```bash
sudo mkdir -p /opt/cards && sudo chown $USER:$USER /opt/cards
cd /opt/cards
git clone git@github.com:YOUR-USER/YOUR-REPO.git .
docker compose build cards
docker compose up -d cards
```

The container exposes port 3000 only on the shared Caddy network — not
publicly. Caddy is the only thing that talks to it.

### 3. Caddy: route /cards/*

Open the existing Caddyfile (typically `/etc/caddy/Caddyfile` or wherever
the rebuilding-iran stack mounts it). Inside the existing
`rebuilding-iran.com { ... }` block, add the contents of
[`Caddyfile.snippet`](./Caddyfile.snippet) **before** the existing
`reverse_proxy` / `file_server` directives. Order matters — Caddy matches
top-down.

Then reload Caddy. The exact command depends on your existing setup; common
patterns:

```bash
# If Caddy runs in a docker-compose service named `caddy`:
docker compose -f /opt/rebuilding-iran/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile

# Or, if Caddy runs as a system service:
sudo systemctl reload caddy
```

Verify in a browser: `https://rebuilding-iran.com/cards/` should load the
home page.

### 4. Local deploy script

On your Mac, configure the deploy environment once. Put these in
`~/.zshrc` or wherever you keep shell config:

```bash
export CARDS_HETZNER_HOST=your-ssh-alias-or-ip      # the SSH alias/IP for the Hetzner box
export CARDS_REMOTE_DIR=/opt/cards                  # where you cloned the repo
export CARDS_CADDY_RELOAD="docker compose -f /opt/rebuilding-iran/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile"
```

`source` your rc file or open a new shell.

## Day-to-day deploy

From the cards app directory:

```bash
git commit -am "your change"
bash deploy.sh
```

That's it. The script:
1. Refuses to deploy with uncommitted changes.
2. Pushes to GitHub.
3. SSHes to the Hetzner box, pulls, rebuilds the container, restarts it.
4. Reloads Caddy if you set `CARDS_CADDY_RELOAD`.
5. Curls `https://rebuilding-iran.com/cards/` and reports status.

## Local dev still works

The launchctl service at `localhost:3737` continues to use bare paths
(no `/cards` prefix). The basePath is only baked in via the
`NEXT_PUBLIC_BASE_PATH` env var, which the Dockerfile sets but the
launchctl service does not.

## Migration to a dedicated domain later

When you get a real domain (e.g. `cards-mcat.app`):

1. Snapshot your data: Settings → Backup → Download snapshot.
2. Add a new top-level Caddy block for the new domain pointing at the same
   `cards:3000` upstream — without the `handle_path /cards/*` wrapping
   (i.e. serve at root). Set the new container's `BASE_PATH=""` build arg.
3. Either:
   - Tear down the `/cards` route once you've imported your snapshot at the
     new origin, OR
   - Leave the old route as a 301 redirect for a while:
     ```caddy
     redir /cards/* https://cards-mcat.app{uri} 301
     ```
4. Open the new URL → Settings → Backup → Import the snapshot. All decks,
   reviews, scheduling, Feynman logs, settings move over.

The whole migration is a 30-min round trip.

## Troubleshooting

- **404 on assets under /cards/**: the SW or manifest is being served from
  the wrong origin. Hard-reload (Cmd+Shift+R) to force a fresh SW
  registration; the SW derives its base from `self.location.pathname`
  automatically.
- **API key prompt on every visit**: each origin (`localhost:3737` vs
  `rebuilding-iran.com/cards`) has its own IndexedDB. Set the key once per
  origin, or enable Supabase sync to share data.
- **Container won't start**: `ssh hetzner 'docker logs --tail 200 cards'`
  to see the Node error.
- **Caddy gives 502 Bad Gateway**: usually means the `cards` container
  isn't on the `caddy_default` network, or the network name in
  `docker-compose.yml` doesn't match your Caddy stack's. Check with
  `docker network inspect caddy_default`.
