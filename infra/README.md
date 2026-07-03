# CGAO local infrastructure

`docker-compose.yml` brings up the backing services for local development:

| Service  | Port | Purpose                                  |
|----------|------|------------------------------------------|
| postgres | 5432 | Authoritative state store (spec §15)     |
| nats     | 4222 | Event bus with JetStream (spec §8, §10)  |
| redis    | 6379 | DLQ + rate-limit counters (spec §10, §18)|
| minio    | 9000 | S3-compatible artifact mock (spec §15)   |

## Start / stop

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml down
```

## Default credentials (dev only)

| Service  | User / Key      | Password / Secret     |
|----------|-----------------|-----------------------|
| postgres | `cgao`          | `cgao_dev`            |
| minio    | `cgao`          | `cgao_dev_secret`     |

These defaults are intentionally non-secret and only suitable for local dev.
Production secrets are provisioned out-of-band via the Trusted Control Runner
(spec §6.4, §13.1).

## Environment variables

The orchestrator reads `DATABASE_URL`, `NATS_URL`, `REDIS_URL`, and
`S3_ENDPOINT` from `.env.local` (gitignored). Defaults align with the
compose file:

```bash
DATABASE_URL=postgres://cgao:cgao_dev@localhost:5432/cgao
NATS_URL=nats://localhost:4222
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=cgao
S3_SECRET_KEY=cgao_dev_secret
```
