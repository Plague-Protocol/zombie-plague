# Deploying Zombie Plague

Three parts, deployed separately:

| Part | Where | Needed for |
|---|---|---|
| The page (`web/`) | Vercel | everything |
| The server (`server/`) | any machine that runs Node 22 or later, with Postgres | sign-in, the guest limit, the leaderboard, last selves, multiplayer, the admin page |
| The contracts (`contracts/`) | Celo Sepolia today (see `docs/DEPLOYMENTS.md`); mainnet later | staked rooms only, which stay switched off |

Without the server the page still plays solo, with no time limit (the guest limit only applies when the server
answers, since a guest could not sign in otherwise). Docker is optional: the server is a plain Node app.

**Order:** the server first (the page needs its address), then the page, then tell the server the page's address.

## 1. The server

It needs Node 22.9 or later, a Postgres database (without `DATABASE_URL` it keeps accounts and runs in memory and
loses them on restart), and an HTTPS address of its own (for example `api.yourdomain`), because the page is HTTPS
and phones refuse a plain `ws://` connection from it.

Its settings (all in `server/.env`, template in `server/.env.example`):

| Variable | Set to |
|---|---|
| `JWT_SECRET` | 32+ random characters: `openssl rand -hex 32`. Changing it signs everyone out. |
| `DATABASE_URL` | `postgres://user:password@host:5432/dbname`. The tables are created on start. |
| `ALLOWED_ORIGINS` | the page's address(es), comma-separated: `https://yourgame.vercel.app,https://yourdomain` |
| `ADMIN_ADDRESSES` | the wallet(s) allowed into the admin page (`?admin`) |
| `CELO_RPC`, `CHAIN_ID` | `https://forno.celo.org` and `42220` on mainnet (lets smart wallets sign in) |
| `STAKED` | leave `false` |
| `PORT` | `8787` unless your host says otherwise |

The server reads the game's rules from `../core` and its step content from `../web/public/content`, so run it from
a clone of the whole repository, not from the `server/` folder alone.

### On a VPS (for example the Lighthouse box)

```sh
git clone <this repo> /opt/zombie-plague && cd /opt/zombie-plague/server
npm ci && npm run build                 # writes dist/server.mjs
cp .env.example .env && nano .env       # the settings above
sudo cp ../deploy/outbreak-server.service /etc/systemd/system/   # edit User= and the paths if yours differ
sudo systemctl enable --now outbreak-server
sudo apt install caddy && sudo cp ../deploy/Caddyfile /etc/caddy/Caddyfile   # set your domain in it
sudo systemctl reload caddy             # Caddy gets the HTTPS certificate itself and passes WebSockets through
```

Point the domain's DNS (an A record) at the machine, and open ports 80 and 443. To update later:
`git pull && npm ci && npm run build && sudo systemctl restart outbreak-server`.

### On Railway or Render (no machine to look after)

Create a service from this repository with the **repository root** as its directory (the server needs `../core`):
build command `cd server && npm ci && npm run build`, start command `cd server && npm start`. Add their Postgres and
put its connection string in `DATABASE_URL`, and the rest of the settings above as environment variables. They
give you an HTTPS address.

**Check:** `https://api.yourdomain/health` answers `{"ok":true,...}` and `/night/today` answers a night number.

## 2. The page on Vercel

In the Vercel project:

- **Root Directory: `web`** (recommended). Keep the setting *Include files outside the root directory in the Build
  Step* switched on: the page is built from `web/` and the rules in `core/` beside it. `web/vercel.json` sets the
  commands and the cache headers. (Leaving the Root Directory as the repository root also works: the root
  `vercel.json` builds `web/`.)
- **Environment variables** (they are built into the page, so redeploy after changing one):
  - `VITE_SERVER_URL` = `wss://api.yourdomain` (the server's address, with `wss://`)
  - `VITE_THIRDWEB_CLIENT_ID` = the client id from your thirdweb dashboard (Google / passkey sign-in). In that
    dashboard, add the page's domain to the client's allowed domains, or the sign-in popup is refused.
  - Leave `VITE_STAKE_STACKS` and `VITE_CHAIN_ID` unset until staked rooms are switched on.

Then add the page's address to the server's `ALLOWED_ORIGINS` and restart the server.

**Check:** open the game, play past the title, open Leaderboard (it loads), Multiplayer (it asks you to sign in;
sign in and Quick play gives you a room), and `?admin` signed in with an admin wallet.

## 3. Staked rooms (later)

Off until the owner has a legal view and the mainnet admin is a multisig: `docs/PHASE2-BUILD-PLAN.md` section 9.
Deploying them is the contract script (one deploy per token, USDm and USDT), then `STAKED=true`, `STAKE_STACKS`,
`BACKEND_KEY` on the server and `VITE_STAKE_STACKS`, `VITE_CHAIN_ID` on Vercel. Addresses so far: `docs/DEPLOYMENTS.md`.

## The page without Vercel (nginx)

The page is a static site, so any web server can host it. `nginx.conf` here serves it compressed and cached so a
second visit downloads almost nothing.

### On your machine

```sh
cd web
npm ci            # exact versions from the lockfile; install scripts are disabled by .npmrc
npm test
npm run build     # writes web/dist/
rsync -avz --delete dist/ USER@SERVER:/var/www/outbreak/
```

### On the server (once)

```sh
sudo apt install nginx            # or your distribution's equivalent
sudo mkdir -p /var/www/outbreak && sudo chown "$USER" /var/www/outbreak
sudo cp nginx.conf /etc/nginx/conf.d/outbreak.conf   # edit server_name first
sudo nginx -t && sudo systemctl reload nginx
```

Open port 80 (and 443) in the Lighthouse firewall panel. For HTTPS, which phones increasingly
expect, use certbot: `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d your.domain`.

### What the config does

| Files | Cache | Why |
|---|---|---|
| `index.html` | always revalidate | so a new build is seen immediately |
| `/assets/*` (built JS, CSS) | 1 year, immutable | names change whenever content changes |
| `/assets/characters/*` | 1 day | model and skins keep their names between builds |

Everything is gzip-compressed (about 208 KB of JavaScript and about 430 KB of character data
over the wire on the first visit; a few KB after that).
