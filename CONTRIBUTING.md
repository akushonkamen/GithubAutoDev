# Contributing to CGAO

CGAO 是围绕 spec v3 (`docs/cgao_spec_v3.md`) 推进的系统。每个 PR 都必须能溯源到一个 spec 章节和一个 tasklist 条目。

## 工作流

1. **先看 spec。** 任何非平凡改动必须先在 `docs/cgao_spec_v3.md` 找到对应章节，否则先开 issue 改 spec。
2. **再认 task。** 每个 PR 描述里写明 `T-Mx-xxx`，对应 `docs/cgao_tasklist_v3.md`。
3. **SHA-bound gate 不跳过。** `--no-verify` 等绕过 hook 的操作必须显式说明原因。
4. **签名验证只在 Trusted Control Runner。** 任何把 IM 平台凭据或 GitHub App key 引入 Untrusted Code Runner 的改动会被拒绝。
5. **用户内容必须经 untrusted envelope。** 任何把 IM 消息原文/issue body/PR description 直接拼进 system prompt 的改动会被拒绝。
6. **审计哈希链不破坏。** 任何 authoritative action（label 设置、approval、merge）必须 append `audit_records`，且 hash 链接前一条。

## 本地开发

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Commit 风格

`T-Mx-xxx <scope>: <imperative summary>`，例如：

```
T-M0-005 events: pin CloudEvents envelope schema and topic registry
```
