# CGAO 事件规范（T-M0-005）

对应 spec：`docs/cgao_spec_v3.md` §10

## 1. Envelope

所有 CGAO 事件均包装为 CloudEvents 1.0 风格 envelope：

```json
{
  "id": "uuid v4",
  "source": "repo:owner/name",
  "type": "intake.webhook.lark",
  "time": "2026-07-03T10:00:00.000Z",
  "subject": "issue#42 / run#c0a801",
  "datacontenttype": "application/json",
  "data": { /* event-specific */ },
  "trace": {
    "repo": "owner/name",
    "run_id": "c0a801" | null,
    "prev_hash": "sha256:..." | null
  },
  "dedup_key": "stable-content-hash"
}
```

Schema 实现：`packages/events/src/envelope.ts` `cgaoEventEnvelopeSchema`。

## 2. Topic 命名规则

- 全小写 dotted kebab-case：`^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$`
- 顶层 group：`webhook` / `intake` / `issue` / `run` / `reconciler` / `error`
- 二级 group：来源 / 子生命周期 / 决策结果
- **不引入** `issue.triage_requested` —— triage 始终是 `issue.created` 后由 MOD-ISSUE 处理

完整 topic 注册表：`packages/events/src/envelope.ts` `CGAO_TOPICS`。

## 3. 幂等

| 字段 | 来源 | 用途 |
|---|---|---|
| `id` | UUID v4 | 事件唯一标识；总线去重 |
| `dedup_key` | 生产者按内容稳定字段计算 | 业务幂等；24h 窗口内 (source, type, subject, dedup_key) 重复即丢弃 |
| `trace.prev_hash` | 前一条 audit_records.hash | 审计哈希链（spec §19） |

## 4. 投递语义

- 至少一次（at-least-once）—— 消费者必须幂等
- 失败重试：指数退避 1s → 30s，最多 5 次
- DLQ：超过重试上限进入 `cgao-dlq` 队列，触发 `error.unhandled`

## 5. 生产者契约

每个模块在发出事件前必须：

1. 计算 `dedup_key`（业务字段 hash）
2. 校验 payload schema（Zod）
3. 填充 `trace` 字段（`run_id` 可空）
4. 写入事件总线 + 同时写 `audit_records` 一条
