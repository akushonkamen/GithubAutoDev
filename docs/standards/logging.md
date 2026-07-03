# CGAO 日志规范

对应 spec：`docs/cgao_spec_v3.md` §6.4（蓝军控制项）、§19（审计链）、§10（事件 trace）

## 1. 设计原则

- **结构化优先**：所有日志条目以 JSON 单行输出（production），开发态可用 pino pretty
- **secret 绝不入日志**：GitHub token、App private key、IM webhook secret、IM 消息原文一律 redact（spec §6.4 C-IM-04/C-IM-13）
- **trace 透传**：所有业务日志必须带 `repo` + `run_id`（可空）+ `event_id`（可空）+ `trace.prev_hash`（可空），与事件 envelope trace 对齐（spec §10）
- **不可篡改**：authoritative action 必须同时写 `audit_records`（spec §19，本规范第 5 节）

## 2. 字段表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ts` | string (ISO-8601 UTC) | ✅ | 事件发生时间（毫秒精度） |
| `level` | enum | ✅ | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `service` | string | ✅ | `orchestrator` / `runner-broker` / `runner-trusted` / `runner-untrusted` / `intake-lark` / ... |
| `module` | string | ✅ | 包名或模块路径，如 `@cgao/policy`、`mod-issue.fsm` |
| `msg` | string | ✅ | 一行人类可读简述 |
| `repo` | string | ❌ | `owner/name`；跨仓库上下文必填 |
| `run_id` | string \| null | ❌ | workflow run 查询键（spec §4.4）；run 尚未建立时为 null |
| `event_id` | string (uuid) | ❌ | 关联的 envelope.id（spec §10） |
| `dedup_key` | string | ❌ | 关联的 envelope.dedup_key |
| `trace` | object | ❌ | `{ prev_hash: string|null, head_hash: string|null }`，与事件 trace 一致 |
| `request_id` | string | ❌ | HTTP 入口分配（webhook 接收时生成） |
| `actor` | string \| null | ❌ | 触发者（GitHub login / IM sender hash）；不可信字段需 `actor_untrusted: true` |
| `action` | string | ❌ | 业务动作枚举，对齐 audit_action（如 `label.set`、`merge.executed`） |
| `latency_ms` | number | ❌ | 关键操作耗时（webhook 处理、LLM 调用、runner job） |
| `error` | object | ❌ | `{ code: string, retryable: bool, cause?: { kind, detail } }`，对齐 `docs/standards/errors.md` |
| `redacted` | string[] | ❌ | 本条日志中被 redact 的字段名列表（透明性） |

## 3. 等级语义

| level | 何时使用 |
|---|---|
| `trace` | 入参/出参详细 dump（仅 dev） |
| `debug` | 内部决策路径（如 policy evaluate 输入/输出） |
| `info` | 业务进展里程碑（run 状态转移、artifact 写入、事件发布） |
| `warn` | 可恢复异常（重试、降级、self-echo 抑制） |
| `error` | retryable=false 错误、DLQ 入队、安全告警 |
| `fatal` | 进程无法继续（DB 连接丢失、签名密钥缺失） |

## 4. Secret redaction 规则

按字段名深度遍历对象，匹配下列模式一律替换为 `[REDACTED]`：

- 字段名命中：`password` / `secret` / `token` / `key` / `private_key` / `webhook_secret` / `authorization` / `cookie` / `bearer`
- 字符串值匹配：`gh[ps]_[A-Za-z0-9]{36}` / `gho_` / `github_pat_` / `-----BEGIN .* PRIVATE KEY-----` / `xoxb-` / `sk-ant-`
- IM 消息正文不得出现在日志中（spec §6.4 C-IM-04）—— 仅可记录 `intake_message_id` + 长度 + 内容 hash

**实现位置：** Orchestrator pino 实例统一加 `redact` 路径，runner-broker 同样配置。

## 5. 审计与日志的边界

| 维度 | 日志 | 审计（audit_records） |
|---|---|---|
| 用途 | 运营 / 调试 / 观测 | 不可篡改证据链 |
| 完整性 | 尽力而为，可截断 | 哈希链强制（spec §19） |
| 触发 | 任意 | 仅 authoritative action（label.set / approval.recorded / merge.executed / intake.* 决策） |
| 存储 | stdout / 文件 / OTLP | PostgreSQL `audit_records` 表 |

**铁律：** 任何 authoritative action 必须**先**写 audit_records、再发业务事件、最后写 info 日志。三者顺序错乱会被 reconciler（T-M10-001）报告为漂移。

## 6. 与 OpenTelemetry 的对齐

- `trace.prev_hash` 字段透传至 OTLP span attribute `cgao.audit.prev_hash`
- `run_id` 透传至 `cgao.run.id`
- `dedup_key` 透传至 `cgao.event.dedup_key`
- event_id 用作 OTLP span 的 `traceId` 关联键

## 7. 引用

- spec §6.4 蓝军强制控制项
- spec §10 事件 envelope trace 字段
- spec §19 审计哈希链
- spec §17.4 / §17.5 Trusted Control Runner 持有 secret
- `docs/standards/errors.md` 错误对象结构
- `docs/standards/events.md` 事件 envelope
