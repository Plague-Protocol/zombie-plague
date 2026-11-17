# Zombie Plague on the Lighthouse box

The box is shared: plague-celo (`/opt/plague`, its Caddy owns ports 80 and 443), shelterflex, and this. This stack
runs the server and its own Postgres, and joins plague-celo's Docker network as `outbreak-api` so that Caddy can
reach it. Nothing here is published to the internet except through Caddy.

```sh
git clone https://github.com/Plague-Protocol/outbreak.git /opt/outbreak
cd /opt/outbreak/deploy/lighthouse
cp .env.example .env && nano .env        # POSTGRES_PASSWORD, JWT_SECRET, ALLOWED_ORIGINS, ADMIN_ADDRESSES
docker compose up -d --build
curl -s 127.0.0.1:8787/health            # {"ok":true,"staked":false}
```

Update: `cd /opt/outbreak && git pull && cd deploy/lighthouse && docker compose up -d --build`.

**Public address.** A site block in plague-celo's Caddyfile (`/opt/plague/deploy/Caddyfile`), then a graceful reload:

```
api.zplague.xyz {
	reverse_proxy outbreak-api:8787
}
```

`docker exec plague-caddy-1 caddy validate --config /etc/caddy/Caddyfile && docker exec plague-caddy-1 caddy reload --config /etc/caddy/Caddyfile`

**Backups:** `pg-backup.sh`, nightly from cron (the line is in the script).

**Memory:** the box has about 1.9 GB for everything. This stack is capped at 384 MB (server) and 192 MB (Postgres).
