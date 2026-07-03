# Malicious Issue Fixtures

These markdown files are the durable prompt-injection corpus used by
security regression tests. Each fixture is a sanitized, clearly-marked
attack sample — never live secret material.

| File | Vector | Maps to |
|---|---|---|
| `ignore-instructions.md` | Direct override | AS-03 / AS-IM-01 |
| `forged-system-tag.md` | Fake `<system>` envelope | AS-03 |
| `hidden-markdown-payload.md` | HTML comment + zero-width | AS-03 |
| `tool-call-injection.md` | Forged `tool_call` fence | AS-04 |
| `cross-platform-impersonation.md` | Forged sender display_name | AS-IM-02 |

Tests should read these files via `import.meta.url` so they remain
decoupled from the test file path.
