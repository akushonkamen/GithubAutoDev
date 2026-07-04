# scripts/

Dev-time helpers for CGAO. None of these are required for production —
they exist to make local bring-up of the GitHub App webhook flow painless.

## `dev-tunnel.sh`

Spins up a Cloudflare quick tunnel (`cloudflared tunnel --url
http://localhost:8787`) so GitHub can deliver App webhooks to the local
orchestrator. Prints the public URL with copy-paste instructions on
stdout. Optional `TUNNEL_DOMAIN` env var requests a stable name;
otherwise the URL rotates on every restart. Exits 1 with install
instructions if `cloudflared` is not on `PATH`.

Usage:

```sh
./scripts/dev-tunnel.sh
# or
TUNNEL_DOMAIN=my-cgao.trycloudflare.com ./scripts/dev-tunnel.sh
```
