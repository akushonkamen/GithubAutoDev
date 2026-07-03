# CGAO 错误码规范（T-M0-005）

对应 spec：`docs/cgao_spec_v3.md` §10 + §20

## 1. 命名空间

错误码采用 `<DOMAIN>_<KIND>` 格式，全大写下划线分隔。

| Domain | 含义 |
|---|---|
| `CFG` | 配置错误（.cgao.yml 解析、缺失） |
| `AUTH` | 签名验证 / 凭据 / 权限 |
| `DEDUP` | 幂等冲突 |
| `STATE` | workflow run 状态机非法转移 |
| `SHA` | SHA-bound gate 不匹配 |
| `RUNNER` | runner 类型不匹配 / secret profile 违规 |
| `LLM` | LLM 调用失败 / 输出 schema 不通过 |
| `ART` | Artifact 写入失败 / hash 不匹配 |
| `INTAKE` | v3 新增：IM intake 相关 |
| `RECON` | reconciler 漂移 |
| `INT` | 内部不可分类错误 |

## 2. 错误对象

```typescript
type Severity = 'info' | 'warn' | 'error' | 'fatal';

interface CgaoError {
  code: string;            // 见上表
  severity: Severity;      // v3 新增：驱动告警路由与 oncall 升级
  message: string;         // 简短描述（不包含 secret）
  retryable: boolean;      // 业务可重试吗
  cause?: {                // 可选，原始错误
    kind: string;
    detail: string;
  };
  trace?: {                // 与事件 trace 一致
    repo: string;
    run_id: string | null;
  };
}
```

### 2.1 severity 语义

| Severity | 触发 | 路由 |
|---|---|---|
| `info` | 业务正常分支（如 `DEDUP_REPLAY` 命中），仅留痕 | log + audit_records，不告警 |
| `warn` | 可恢复异常，需观察但不阻塞 | log + 周期聚合告警 |
| `error` | 阻塞当前 run 但未污染状态 | log + 立即告警 |
| `fatal` | 安全 / 完整性事件（如 `AUTH_*`、`SHA_GATE_MISMATCH`、`ART_HASH_MISMATCH`、`RECON_DRIFT`、`AUTH_RUNNER_SECRET_VIOLATION`） | log + 立即告警 + 触发 run freeze；reconciler 升级处理 |

`severity` 由错误码常量定义处指定，业务层不得降级。任何新增错误码必须在此文档登记 severity。

## 3. 必备语义

- 任何错误**不得**包含 secret、token、App key、IM 消息原文
- `retryable=true` 的错误由总线指数退避重试
- `retryable=false` 的错误进入 `error.unhandled` topic + DLQ

## 4. 通用错误码（最小集）

| Code | Severity | Retryable | 含义 |
|---|---|---|---|
| `CFG_PARSE_FAILED` | error | false | .cgao.yml 解析或 schema 校验失败 |
| `CFG_MISSING` | error | false | 必要配置项缺失 |
| `AUTH_SIGNATURE_INVALID` | fatal | false | webhook 签名不匹配 |
| `AUTH_TOKEN_MISSING` | fatal | false | Trusted Control Runner 缺少必要 secret |
| `AUTH_RUNNER_SECRET_VIOLATION` | fatal | false | Untrusted Code Runner 检测到 secret 注入（§13.1） |
| `DEDUP_REPLAY` | info | false | 24h 内重复事件 |
| `STATE_ILLEGAL_TRANSITION` | error | false | workflow run 状态机非法转移 |
| `SHA_GATE_MISMATCH` | fatal | false | SHA-bound gate 不匹配（spec/plan/approval/head/base） |
| `RUNNER_TYPE_MISMATCH` | fatal | false | job 没有运行在正确的 runner label 上 |
| `LLM_TIMEOUT` | warn | true | LLM 调用超时 |
| `LLM_SCHEMA_INVALID` | warn | false | LLM 输出无法通过 schema 校验 |
| `ART_HASH_MISMATCH` | fatal | false | Artifact sha256 与内容不匹配 |
| `INTAKE_DEDUP` | info | false | v3：Intake dedup_key 命中 |
| `INTAKE_RATE_LIMITED` | warn | true | v3：超过 LLM 调用预算 |
| `INTAKE_ROUND_LIMIT` | warn | false | v3：超过 max_clarify_rounds |
| `RECON_DRIFT` | fatal | false | reconciler 检测到状态漂移 |
| `INT_UNHANDLED` | error | false | 内部不可分类错误，必须人工 |

## 5. 抛错模式（建议）

```typescript
import { CgaoError } from '@cgao/errors'; // M1 起接入

throw new CgaoError({
  code: 'SHA_GATE_MISMATCH',
  message: 'plan_sha in approval does not match generated plan',
  retryable: false,
  trace: { repo, run_id },
});
```

`@cgao/errors` 包在 M1 落地。M0 仅在此文档登记命名空间与必备码。
