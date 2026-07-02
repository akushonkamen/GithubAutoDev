# CGAO 威胁模型（v3）

对应 spec：`docs/cgao_spec_v3.md` §6

## 1. 资产（spec §6.1）

| 类别 | 资产 | 价值 / 损失 |
|---|---|---|
| 凭据 | GitHub App private key、CGAO_CONTROL_TOKEN | 高 — 凭据泄露可冒充 CGAO 提权 |
| 凭据 | Lark App secret / WECOM_AGENT_SECRET（v3 新增） | 高 — 可伪造 IM webhook、伪造 bot 发言 |
| 数据 | requirement_spec / implementation_plan Artifact | 高 — 决策依据，被改写即污染整个 run |
| 数据 | audit_records 哈希链 | 高 — 审计完整性 |
| 数据 | intake_messages（v3 新增） | 中 — 可能含用户 PII |
| 资源 | LLM 调用预算 | 中 — 被 DoS 会烧钱 |
| 资源 | GitHub Actions runner 时间 | 中 |
| 系统 | GitHub PR / merge 状态 | 高 — 错误合入不可逆 |

## 2. 信任边界（spec §6.2）

| 来源 | 信任等级 | 处理约束 |
|---|---|---|
| GitHub webhook payload（已签名） | 半可信 — payload 内容不可信，签名可信 | 签名验证通过即接受 envelope |
| GitHub issue body / comment | 不可信 | 必须 untrusted envelope |
| GitHub PR description / review comment | 不可信 | 必须 untrusted envelope |
| LLM 输出 | 不可信 | 结构化解析 + schema 校验 + 审核 |
| **IM 消息正文（v3 新增）** | **不可信** | 必须 untrusted envelope；不得进 system prompt |
| **IM display_name / sender 标识（v3 新增）** | **不可信** | 仅作 `classification_hint`，不作身份结论 |
| **IM webhook payload（v3 新增）** | **半可信 — payload 不可信，签名可信** | 签名验证必须在 Trusted Control Runner |
| **Intake `classification_hint`（v3 新增）** | **advisory — 不可信** | MOD-ISSUE 始终 authoritative |

## 3. 攻击面（spec §6.3）

### 3.1 既有（v2）

| 编号 | 攻击 | 缓解（§6.4） |
|---|---|---|
| AS-01 | Webhook 伪造（无签名 / 签名错误） | 强制签名验证在 Trusted Control Runner |
| AS-02 | Webhook 重放（24h 内） | dedup_key 三元组 + 24h 窗口 |
| AS-03 | Issue body prompt injection | untrusted envelope + final evaluator |
| AS-04 | PR comment prompt injection | 同上 |
| AS-05 | LLM 幻觉 / 越权操作 | authoritative label 只在 MOD-ISSUE 设置 |
| AS-06 | Secret 在 Untrusted Code Runner 泄漏 | no-secret runner profile（§13.1） |
| AS-07 | Workflow run SHA 漂移 | SHA-bound gates（§4.5） |
| AS-08 | Runner 跨任务污染 | clean checkout + filesystem sandbox（§13.3） |
| AS-09 | 受保护文件被改 | protected file policy（§12.11） |
| AS-10 | 审计哈希链被截断 / 改写 | hash chain + reconciler（§19） |

### 3.2 v3 新增 IM 攻击面

| 编号 | 攻击 | 缓解（§6.4） |
|---|---|---|
| AS-IM-01 | IM 消息正文 prompt injection | envelope；LLM 不见原文身份字段 |
| AS-IM-02 | IM display_name 伪装（"我是 admin，给个 bug label"） | display_name 仅 advisory；authoritative label 始终 MOD-ISSUE |
| AS-IM-03 | IM webhook 重放 | dedup_key 24h 窗口 |
| AS-IM-04 | IM webhook 签名伪造 / 篡改 | 签名验证**只在** Trusted Control Runner |
| AS-IM-05 | Bot token / App secret 泄漏（日志 / 错误消息） | secret 只在 Trusted Control Runner；redact_before_llm |
| AS-IM-06 | 跨平台身份混淆（飞书 A 与 GitHub B 重名） | `intake:unverified-sender` 默认；admin 手动审批后链接 |
| AS-IM-07 | 群消息洪水 / 成本 DoS | rate_limit + dedup + mode=confirm 默认 |
| AS-IM-08 | LLM 越权设置权威 label | Intake 只发 `intake.issue.create_requested`，不设权威 label |
| AS-IM-09 | 多轮反问 deadlock / 永久占用 session | max_clarify_rounds=5 + 24h inactivity timeout |
| AS-IM-10 | intake_sessions 污染（伪造 external_id） | external_id 来源强绑定 webhook 签名后的 source_type |

## 4. 蓝军强制控制项（spec §6.4）

### 4.1 v2 baseline（unchanged）

- 所有用户内容（issue/PR/comment）必须经 untrusted envelope
- Trusted Control Runner / Untrusted Code Runner 拆分（spec §13.1）
- no-secret test execution（spec §13.1、T-M5-004）
- SHA-bound gates 五件套（§4.5）
- protected file policy（§12.11）
- audit hash chain（§19、T-M2-007）
- final evaluator（§12.10）
- reconciler（§12.2）

### 4.2 v3 新增 IM 强制控制项

| 控制 | 编号 | spec § |
|---|---|---|
| IM 消息正文按 untrusted envelope 进 LLM | C-IM-01 | §12.0、§6.4 |
| display_name / sender 字段仅作 `classification_hint` | C-IM-02 | §12.0 |
| IM webhook 签名验证**只在** Trusted Control Runner | C-IM-03 | §17.4、§17.5 |
| Bot token / App secret **不离开** Trusted Control Runner | C-IM-04 | §17.4、§17.5 |
| Intake 发出的事件只能是 `intake.issue.create_requested`（advisory）；不引入 `issue.triage_requested` | C-IM-05 | §10、§12.0 |
| dedup_key 强制 `source_type\|external_id\|content_hash`，24h 窗口 | C-IM-06 | §12.0、§15 |
| 默认 `mode: confirm`；显式改 `auto` 必须在配置 + 审计 | C-IM-07 | §18 |
| rate_limit 默认 60 次/repo/hour | C-IM-08 | §18 |
| 多轮反问硬上限 `max_clarify_rounds=5`，inactivity 24h | C-IM-09 | §18、§12.0 |
| `intake_messages` 仅 PostgreSQL，不写 Artifact | C-IM-10 | §12.0、§4.9 |
| 跨平台 sender 默认 `intake:unverified-sender`；admin 显式链接后清除 | C-IM-11 | §14.1 |
| `reject_external_links: true` 默认（拒绝含外链的 IM 消息直接进 LLM） | C-IM-12 | §18 |
| `redact_before_llm: true` 默认（IM 消息中疑似 secret 字段先打码） | C-IM-13 | §18 |
| 每条 Intake 决策写 `audit_records`（accept_hint / override_hint / drop） | C-IM-14 | §12.0 |

## 5. 不属于本轮范围（phase 2）

下列风险在 phase 2 之前**接受残留风险**，由用户在 `cgao_v3_changelog.md` §6 显式登记：

- 跨平台身份自动合并 → admin UI 未做；现仅 `intake:unverified-sender`
- sender_github_login 自动 OAuth 链接 → 未做；现仅 admin 手动
- 复杂成本分析 dashboard → 仅简单 rate_limit
