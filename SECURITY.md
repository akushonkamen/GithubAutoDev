# Security Policy

## Threat Model

See `docs/security/threat-model.md`（spec v3 §6 的展开）。

## Reporting a vulnerability

请勿在公开 issue 中提交安全漏洞。直接联系维护者。

## Hard invariants

下列硬约束**任何 PR 都不能违反**：

1. **签名验证只在 Trusted Control Runner。** 飞书 `X-Lark-Signature`、WeCom `msg_signature`、GitHub webhook `x-hub-signature-256` 必须在 `runs-on: cgao-trusted-runner` 的 workflow 内执行；绝不在 Untrusted Code Runner 或 webhook gateway 外执行。
2. **平台凭据不出 Trusted Control Runner。** `LARK_APP_SECRET`、`WECOM_AGENT_SECRET`、`GITHUB_APP_KEY` 等只在 Trusted Control Runner 可见；Untrusted Code Runner 的 `allowed_secrets` 恒为 `[]`。
3. **用户内容必须经 untrusted envelope。** IM 消息、issue body、PR description、code review comment 都是不可信输入；进入 LLM 前必须经 envelope 包装（spec §12.4）。
4. **SHA-bound gate 不可绕过。** spec_sha / plan_sha / approval_sha / head_sha / base_sha 任一不匹配即终止 workflow（spec §4.5）。
5. **审计哈希链不可破坏。** 每个 authoritative action append 一条 `audit_records`，`prev_hash` 链接前一条；任何不写 audit 的状态变更都是无效的（spec §19、T-M2-007）。
6. **Advisory 与 authoritative 分离。** MOD-INTAKE 只发 `intake.issue.create_requested`，**绝不**发 `issue.triage_requested`（该事件类型不存在）；权威 label（`bug`/`feature`/`security`）只能由 MOD-ISSUE 设置。
7. **不可信 runner 不持 secret。** `no-secret test execution` 强制：CI 即使注入了 secret 也必须当作没有运行（spec §13.1、T-M5-004）。
