# GitHub App registration walkthrough

This document walks an operator through registering the CGAO GitHub App,
installing it on the test repo, and populating the local `.env` so the
orchestrator can boot in `CGAO_RUNTIME=real` mode.

The whole flow takes ~10 minutes plus GitHub's App-creation latency.

## 0. Pre-flight

- `pnpm install` has run.
- Docker is up. `pnpm dev:up` brought the backing services up; verify
  with `docker compose -f infra/docker-compose.yml ps` — postgres,
  nats, redis, minio should all show `healthy`.
- `pnpm db:migrate` applied cleanly against
  `postgresql://cgao:cgao_dev@localhost:5432/cgao`.
- The orchestrator runs locally on port `8787` (default).
- `cloudflared` is installed. If not:

  ```sh
  brew install cloudflared
  ```

## 1. Start the tunnel

In one terminal:

```sh
./scripts/dev-tunnel.sh
```

Cloudflare will print a public URL like:

```
https://<random>.trycloudflare.com
```

Leave it running. The URL is valid until the tunnel process exits —
restart it and you'll get a fresh name (unless you set
`TUNNEL_DOMAIN` for a stable quick tunnel).

## 2. Generate the webhook secret

```sh
openssl rand -hex 32
```

Save the output — you'll paste it into the App settings page *and*
into `.env` as `GITHUB_WEBHOOK_SECRET`. Treat it like a password.

## 3. Create the GitHub App

Open <https://github.com/settings/apps/new> and fill in:

| Field                        | Value                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| **GitHub App name**          | `cgao-dev` (or any globally unique name you control)                   |
| **Homepage URL**             | `http://localhost:8787` (or your repo's homepage)                       |
| **Webhook URL**              | `https://<tunnel-url-from-step-1>/github/webhook`                      |
| **Webhook secret (optional)**| The hex string from step 2                                              |
| **Where can this app be installed?** | Only on this account (dev) — or your org if sharing              |
| **Expire user authorization tokens** | unchecked (we use installation tokens, not user tokens)        |
| **Webhook**                  | Active                                                                  |
| **Repository permissions**   | see table below                                                         |
| **Subscribe to events**      | see list below                                                          |

### Repository permissions

| Permission        | Setting           | Why                                             |
| ----------------- | ----------------- | ----------------------------------------------- |
| **Issues**        | Read and write    | Triage, label sync, status comments             |
| **Pull requests** | Read and write    | PR create / merge / close                       |
| **Contents**      | Read and write    | Branch creation, commits                        |
| **Workflows**     | Read and write    | Required-check gate evaluation                  |
| **Administration**| Read-only         | Branch-protection snapshot                      |
| **Checks**        | Read-only         | `check_run` ingest for gate evaluation          |

> Do NOT enable "Bypass branch protection" — the security model
> (spec §6.4 AS-04) requires the App to honor every required review
> and check the human team configured. Bypass breaks the trust
> contract.

### Subscribe to events

Tick the boxes for:

- `Issues`
- `Issue comment`
- `Pull request`
- `Pull request review`
- `Push`
- `Check run`
- `Merge group`

Click **Create GitHub App**.

## 4. Capture the App secrets

After creation you land on the App settings page. Capture:

- **App ID** (numeric, near the top of "General settings").
- **Client ID** (also on general settings — used for OAuth flows; CGAO
  doesn't need it in Phase 1 but you should record it).
- **Client secret** (generate one; record it for future use).
- **Private key (.pem)**: click **Generate a private key** and download
  the `.pem`. This is the only time GitHub will hand it to you.

## 5. Install the App

1. On the App settings page left sidebar, click **Install App**.
2. Pick the account / org you created the App under.
3. Choose **Only select repositories** and pick your test repo (e.g.
   `your-user/cgao-test-repo`).
4. Click **Install**.

After install, GitHub redirects to a URL like:

```
https://github.com/settings/installations/<INSTALLATION_ID>
```

The numeric `<INSTALLATION_ID>` in that URL is your
`GITHUB_INSTALLATION_ID`. Capture it.

(Alternatively: query it via the API.)

```sh
# After installing, list installations of your App:
curl -s -H "Authorization: Bearer $(jq -r .jwt /tmp/app.jwt)" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/app/installations | jq '.[].id'
```

## 6. Create `cgao:` labels in the test repo

The orchestrator's label projection (spec §12.6) reads and writes these
labels to triage issues. Create them in your test repo under
**Issues → Labels**:

| Label             | Color suggestion | Notes                                     |
| ----------------- | ---------------- | ----------------------------------------- |
| `cgao:new`        | `#0e8a16` (green) | Newly triaged, awaiting classification    |
| `cgao:plan-ready` | `#1d76db` (blue)  | Spec + plan written; awaiting dev handoff  |
| `cgao:dev-ready`  | `#fbca04` (yellow)| Plan accepted; runner may pick up         |
| `cgao:review-ready` | `#5319e7` (purple) | PR open; review in progress             |
| `cgao:merged`     | `#6e6e6e` (grey)  | PR merged; issue auto-closed             |
| `cgao:blocked`    | `#b60205` (red)   | Hit a gate failure or operator hold       |

## 7. Populate `.env`

Copy `.env.example` to `.env` (gitignored) at the repo root and fill in
the values from steps 2–5:

```sh
cp .env.example .env
```

The completed file should look like:

```dotenv
CGAO_RUNTIME=real

PORT=8787

GITHUB_WEBHOOK_SECRET=<the 64-hex-char string from step 2>

GITHUB_APP_ID=<App ID from step 4>
GITHUB_APP_PRIVATE_KEY="<paste the full .pem contents from step 4 here — multi-line, including the BEGIN/END header and footer lines>"
GITHUB_INSTALLATION_ID=<installation id from step 5>

CGAO_BOT_LOGIN=<your-app-slug>[bot]
CGAO_APP_USER_AGENT=cgao-orchestrator

DATABASE_URL=postgresql://cgao:cgao_dev@localhost:5432/cgao

# Phase 2 — leave defaults; runtime leaves artifacts=null today.
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=cgao-artifacts
S3_ACCESS_KEY_ID=cgao
S3_SECRET_ACCESS_KEY=cgao_dev_secret
S3_REGION=us-east-1

CGAO_REPO_ROOT=
TUNNEL_DOMAIN=
```

> The `.pem` value with embedded newlines works in `.env` because
> `dotenv` parses double-quoted values literally. If your shell gives
> you trouble, write the key to disk and have your process manager
> `cat` it into the env var on startup instead.

## 8. Boot the orchestrator

```sh
pnpm --filter @cgao/orchestrator dev
```

You should see:

```
[cgao-orchestrator] listening on :8787
```

## 9. Verify the webhook path

With the tunnel still running, on GitHub:

1. Open the test repo.
2. Open a new issue titled `cgao: test` with body `cgao:new`.
3. Watch the orchestrator's stdout — you should see the webhook arrive
   and the issue classifier fire (or a 401 / 400 if the secret is
   wrong).

For automated verification, run the boot-smoke e2e test (T-B1-007):

```sh
CGAO_SMOKE=1 pnpm --filter @cgao/e2e-tests test -- boot-smoke
```

That asserts `/healthz`, `/metrics`, signature rejection, and the
signed-payload happy path end-to-end against real Postgres.

## 10. When you're done

- `Ctrl-C` the tunnel and the orchestrator.
- `pnpm dev:down` to tear down the docker compose stack.
- The GitHub App can stay registered across sessions; only the webhook
  URL needs to be updated to the new tunnel domain on the next dev
  session.
