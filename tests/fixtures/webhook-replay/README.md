# Webhook Replay Fixtures

Sanitized webhook payloads with detached signature secrets. Used by
the replay / forgery regression suite under `tests/security/`.

| File | Source | Maps to |
|---|---|---|
| `github-pr-closed.json` | GitHub PR closed event | AS-01 / AS-02 |
| `github-issue-labeled.json` | GitHub issue labeled event | AS-01 |
| `lark-im-receive.json` | Lark IM receive event | AS-IM-03 / AS-IM-04 |
| `wecom-msg.json` | WeCom message event | AS-IM-03 |

Signatures are NEVER stored alongside the payload. Tests compute the
HMAC at runtime using a test-only secret from `process.env.TEST_WEBHOOK_SECRET`
(default: `'cgao-test-secret'`).
