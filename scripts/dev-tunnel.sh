#!/usr/bin/env bash
# dev-tunnel.sh — spin up a cloudflared quick tunnel to localhost:8787
# so GitHub App webhooks can reach the local orchestrator during dev.
#
# Two modes:
#   1. Stable quick tunnel (default):
#        cloudflared tunnel --url http://localhost:8787
#      Cloudflare prints a random trycloudflare.com URL on stdout.
#   2. Named quick tunnel via TUNNEL_DOMAIN:
#        TUNNEL_DOMAIN=my-cgao.trycloudflare.com ./scripts/dev-tunnel.sh
#      Sets --hostname <TUNNEL_DOMAIN>. trycloudflare.com still issues the
#      routing; the name just becomes stable across restarts.
#
# Either way, copy the printed URL into the GitHub App webhook field and
# append `/github/webhook` (the orchestrator's POST path).
#
# Requires: cloudflared on PATH. Install via `brew install cloudflared`.

set -euo pipefail

PORT="${PORT:-8787}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared is not installed." >&2
  echo "Install it via one of:" >&2
  echo "  macOS:  brew install cloudflared" >&2
  echo "  Debian/Ubuntu:  see https://pkg.cloudflareclient.com/" >&2
  echo "  Other:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
fi

args=(tunnel --url "http://localhost:${PORT}")
if [[ -n "${TUNNEL_DOMAIN:-}" ]]; then
  args+=(--hostname "${TUNNEL_DOMAIN}")
fi

cat <<EOF

-------------------------------------------------------------------------------
cloudflared starting — look for the line that looks like:

    https://<random>.trycloudflare.com

That is your public tunnel URL. Paste it into the GitHub App webhook field
followed by /github/webhook, e.g.:

    https://<random>.trycloudflare.com/github/webhook

Stop the tunnel with Ctrl-C. The URL rotates on every restart unless you
set TUNNEL_DOMAIN for a stable name.
-------------------------------------------------------------------------------

EOF

exec cloudflared "${args[@]}"
