# Attack Scenario: Webhook Replay & Forgery

> 对应威胁模型：AS-01（webhook 伪造）、AS-02（webhook 重放）、AS-IM-03（IM 重放）、AS-IM-04（IM 签名伪造）
> 对应 spec：§6.3、§6.4、§12.1（webhook ingress）、§15（dedup）
> 对应 tasklist：T-M0-004、T-M1-001（webhook endpoint）、T-M1-002（dedup）、T-M1-006（replay tests）

## 1. 攻击描述

CGAO 的 webhook ingress 是 issue/PR/IM 事件的唯一权威入口。攻击向量：

- **无签名伪造**：直接 POST 伪造事件（如伪造 `pull_request.closed` 关闭攻击者 PR）
- **签名伪造**：尝试逆推 `X-Hub-Signature-256`（HMAC-SHA256 with webhook secret）
- **签名重放**：截获合法 webhook，在 24h 内多次重放
- **跨平台重放**：截获飞书 webhook，改请求头伪装成 WeCom 重发
- **payload 篡改**：签名算法漏洞（如 GitHub 老 `sha1=` 前缀），降级攻击

## 2. 受影响资产

| 资产 | 损失路径 |
|---|---|
| issue/PR 状态机 | 伪造事件触发非法状态转移 |
|权威 label | 伪造 `issues.labeled` 设 `bug` |
| Intake sessions | 伪造 `intake.webhook.lark` 创建任意 issue |
| LLM 预算 | 重放导致重复 LLM 调用 |
| audit_records | 重放产生重复 audit 记录 |

## 3. 控制点（CGAO 强制）

引用 spec §12.1、§6.4：

| 控制 | 实现位置 |
|---|---|
| **签名验证强制在 Trusted Control Runner**（C-IM-03） | runner-broker / Trusted Control Runner workflow |
| **签名密钥不离开 Trusted Control Runner**（C-IM-04） | secret 注入只在 trusted label |
| **HMAC-SHA256 + timing-safe compare** | `@cgao/github` `verifyGithubSignature()` |
| **dedup_key 24h 窗口**（spec §4.4、§15） | `github_deliveries` 表 + `intake_messages` 表 |
| **dedup 三元组**：`source_type\|external_id\|content_hash`（C-IM-06） | EventBus dedup middleware |
| **raw payload 写 Artifact** | 用于事后取证 + 完整性校验 |
| **每次 delivery 写 `github_mutations`**（T-M1-004） | origin suppression 防止 self-echo |

## 4. 攻击示例（脱敏）

### 4.1 重放（同 delivery id 24h 内）

```text
attacker captures:  POST /github/webhook
                    X-GitHub-Delivery: <uuid-1>
                    X-Hub-Signature-256: sha256=<valid-hmac>
                    body: {"action":"closed", ...}

replay 1: identical request 5 minutes later
replay 2: identical request 1 hour later
...
replay 10: identical request 23 hours later

EXPECTED: dedup middleware hits (source=github, type=*, subject=<uuid-1>)
          → DEDUP_REPLAY error, request returns 200 but no business event emitted
          → audit_records append `webhook.deduped`
```

### 4.2 签名伪造

```text
attacker POSTs without X-Hub-Signature-256  → AUTH_SIGNATURE_INVALID
attacker POSTs with wrong secret's HMAC     → AUTH_SIGNATURE_INVALID
attacker POSTs with sha1= prefix (legacy)   → AUTH_SIGNATURE_INVALID
```

### 4.3 跨平台身份混淆（AS-IM-06）

```text
attacker captures Lark webhook signed with LARK_APP_SECRET
replays to /intake/wecom/webhook with WeCom headers
EXPECTED: WeCom signature verification uses WECOM_AGENT_SECRET
          → AUTH_SIGNATURE_INVALID
```

## 5. 检测与响应

| 检测点 | 实现 |
|---|---|
| 签名失败率 | `AUTH_SIGNATURE_INVALID` 错误计数 + alert |
| dedup 命中率 | `DEDUP_REPLAY` 错误计数 |
| 异常 delivery id | `github_deliveries` 表中 source IP 与签名 secret 不匹配的统计 |
| 时序异常 | 同 subject 短时间内多次 delivery 触发告警 |

## 6. 测试任务映射

| Fixture / 测试 | tasklist |
|---|---|
| `tests/fixtures/webhook-replay/github-*.json` | T-M0-004 |
| `tests/fixtures/webhook-replay/lark-*.json` | T-M0-004 |
| `tests/security/webhook-replay.test.ts` | T-M0-004 / T-M1-006 |
| `tests/security/webhook-forgery.test.ts` | T-M0-004 / T-M1-006 |
| cross-platform replay（v3 新增） | T-INTAKE-010 |

## 7. 蓝军演练清单

- [ ] 无签名 POST
- [ ] 错误 secret 签名
- [ ] `sha1=` 降级
- [ ] signature header 注入（CRLF）
- [ ] 同 delivery 24h 内 10 次重放（spec §12.1 验收用例）
- [ ] 同 delivery 24h+ 1 次重放（应被允许）
- [ ] 跨平台 secret 复用（Lark secret 试 WeCom）
- [ ] 跨 subject 重放（uuid 改变但内容相同）
- [ ] POST body 中 delivery id 与 header 不一致
- [ ] body 改动 1 字节后用旧签名
