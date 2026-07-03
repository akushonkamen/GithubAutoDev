# CGAO 实施任务清单 v3

文档状态：Draft 3.0  
日期：2026-07-03  
关联规格：`cgao_spec_v3.md`  
关联变更记录：`cgao_v3_changelog.md`  
关联访谈 spec：`.omc/specs/deep-interview-cgao-intake-extension.md`  
目标系统：CGAO — Claude GitHub Automation Orchestrator  
上一版本：`cgao_tasklist_v2.md`

## 1. 使用说明

本任务清单按里程碑组织。每个任务包含：

```text
ID：任务编号
Spec：对应规格章节或模块
优先级：P0 / P1 / P2
依赖：前置任务
产物：必须交付的代码、配置、文档或测试
验收：完成判定
```

状态标记：

```text
[ ] 未开始
[~] 进行中
[x] 完成
[!] 阻塞
[-] 暂缓
```

优先级：

```text
P0：MVP 与安全基线必须完成
P1：生产可用必须完成
P2：增强能力
```

## 2. v2 MVP Definition of Done

MVP 要形成以下闭环：

```text
issue opened
  → triage
  → RequirementSpec
  → ImplementationPlan
  → /approve-plan plan_id@plan_sha
  → Claude Code implementation in sandbox
  → clean checkout validation
  → fast gate test in no-secret runner
  → PR created
  → AI review comment
  → SHA-bound merge-ready evaluation
  → maintainer merge
```

MVP 不做全自动高风险合入，不做多 worktree 并行，不做复杂 dashboard。

MVP 安全基线必须完成：

```text
Webhook signature verification
Delivery deduplication
Origin suppression
Command authorization
plan_id@plan_sha approval
SHA-bound spec/plan/test/review/merge gates
Trusted control runner / untrusted code runner split
No-secret test execution
Filesystem sandbox baseline
Clean checkout validation
Protected files risk escalation
Prompt injection regression test
Package script exfiltration regression test
Forbidden path escape regression test
Merge final evaluator baseline
Reconciler baseline
Artifact redaction baseline
```

## 3. 里程碑总览

| Milestone | 名称 | 目标 | 优先级 |
|---|---|---|---|
| M0 | 项目骨架与安全基线 | 建立仓库、服务、配置、威胁模型和测试框架 | P0 |
| M1 | Webhook 与事件底座 | 接收 GitHub 事件、去重、标准化、origin suppression | P0 |
| M2 | 状态机、Artifact 与 hash 绑定 | 建立内部状态源、artifact、generation、SHA-bound gates | P0 |
| M-INTAKE | Issue Intake 模块（v3 新增） | 飞书 + WeCom IM 入口，三层触发，advisory 分类，建 issue 进入既有 pipeline | P0 |
| M3 | Issue 管理与命令授权 | triage、智能回复、强命令授权、计划审批 | P0 |
| M4 | 需求分析与规划 | 生成 spec、plan、审批 gate、防 prompt injection | P0 |
| M5 | Runner 隔离与开发模块 | 接入 Claude Code，拆分 runner 权限域，建立 sandbox | P0 |
| M6 | 测试与修复循环 | no-secret fast gate、失败诊断、有界修复、安全回归测试 | P0 |
| M7 | Commit 与 PR | 分支、commit、PR body、去重、protected file 检查 | P0 |
| M8 | 审查模块 | code-reviewer、安全审查、finding lifecycle | P1 |
| M9 | 合入模块 | SHA-bound final evaluator、merge-ready、merge queue 支持 | P1 |
| M10 | Reconciler、审计与运营 | 状态恢复、观测、成本、审计链、artifact 治理 | P1 |
| M11 | 生产增强 | Agent SDK runner、并行 worktree、多仓库、dashboard | P2 |

## 4. M0：项目骨架与安全基线

> **[audit 2026-07-03]** M0 实际仍在进行中。详见 `docs/audit/T-M0-audit-2026-07-03.md`。commit `b01cdf0` 过度声明完成度，仅 T-M0-005 达标。

### [x] T-M0-001 初始化 monorepo <!-- reconciled 2026-07-04: apps/orchestrator + apps/runner-broker + packages/{events,eventbus,github,github-events,policy,artifacts,audit,db,schemas,test-utils} + infra/docker-compose.yml + .github/workflows/ci.yml 全部到位；typecheck/test 全绿 -->

Spec：第 8、15、16 节  
优先级：P0  
依赖：无

产物：

```text
apps/orchestrator
apps/runner-broker
packages/events
packages/policy
packages/github
packages/artifacts
packages/audit
infra/docker-compose.yml
```

验收：

```text
本地可以启动 orchestrator、db、event bus、artifact mock
CI 可运行 lint/typecheck/unit
```

### [x] T-M0-002 建立统一代码规范 <!-- reconciled 2026-07-04: commitlint.config.mjs 强制 T-Mx-xxx 格式；docs/standards/{errors,events,logging}.md 齐；Biome + tsconfig.strict + vitest 全 workspaces -->

Spec：第 4、23 节  
优先级：P0  
依赖：T-M0-001

产物：

```text
eslint / prettier / tsconfig
commitlint
测试目录规范
错误码规范
日志字段规范
```

验收：

```text
CI 中 lint/typecheck/test 全部通过
新增模块必须有基础单测
```

### [x] T-M0-003 定义 v2 威胁模型文档 <!-- reconciled 2026-07-04: docs/security/threat-model.md + attack-scenarios/{prompt-injection,runner-exfiltration,stale-merge,webhook-replay}.md 4 篇齐 -->

Spec：第 6 节  
优先级：P0  
依赖：T-M0-001

产物：

```text
docs/threat-model.md
attack-scenarios/prompt-injection.md
attack-scenarios/runner-exfiltration.md
attack-scenarios/stale-merge.md
attack-scenarios/webhook-replay.md
```

验收：

```text
覆盖 prompt injection、runner secret exfiltration、forged marker、stale approval、TOCTOU merge、external PR artifact 污染
每个攻击场景都有对应控制点和测试任务
```

### [x] T-M0-004 建立安全回归测试框架 <!-- reconciled 2026-07-04: tests/security/ 6 测试 + helpers (dedup/env-scrub/replay) 齐；20 tests 全绿 -->

Spec：第 6、21、23 节  
优先级：P0  
依赖：T-M0-001, T-M0-003

产物：

```text
tests/security/
tests/fixtures/malicious-issues/
tests/fixtures/malicious-repos/
tests/fixtures/webhook-replay/
```

验收：

```text
可在 CI 中运行安全回归测试
测试失败会阻断 merge
```

### [x] T-M0-005 定义事件与错误码规范 <!-- audit 2026-07-03: 达标，envelope/tests/standards 全在；@cgao/errors 包按 spec 推迟到 M1 -->

Spec：第 10、20 节  
优先级：P0  
依赖：T-M0-001

产物：

```text
packages/events/schemas/*.json
packages/errors/codes.ts
docs/event-contract.md
```

验收：

```text
所有事件 schema 可校验
错误码包含 module、reason、retryable、severity
```

## 5. M1：Webhook 与事件底座

### [x] T-M1-001 实现 GitHub webhook endpoint

Spec：第 12.1 节  
优先级：P0  
依赖：T-M0-001

产物：

```text
POST /github/webhook
signature verification
event/action parser
raw payload artifact writer
```

验收：

```text
有效签名事件 accepted
无效签名 rejected
原始 payload 保存为 artifact
```

### [x] T-M1-002 实现 delivery deduplication

Spec：第 12.1、15 节  
优先级：P0  
依赖：T-M1-001

产物：

```text
github_deliveries table
delivery idempotency middleware
```

验收：

```text
同一 X-GitHub-Delivery 重放 10 次只产生 1 个业务事件
重复请求返回 200，不重复处理
```

### [x] T-M1-003 实现事件标准化

Spec：第 10 节  
优先级：P0  
依赖：T-M1-001

产物：

```text
GitHub payload → CloudEvents mapper
issue/pr/review/workflow event schemas
```

验收：

```text
issues.opened、issue_comment.created、pull_request.synchronize、workflow_run.completed 可映射为标准事件
映射事件包含 correlation_id、repo、run_id 或 run lookup key
```

### [x] T-M1-004 实现 origin suppression

Spec：第 12.1、14.2、15 节  
优先级：P0  
依赖：T-M1-002

产物：

```text
github_mutations table
mutation recorder
self-echo detector
```

验收：

```text
CGAO 自己创建/编辑的 status comment 不触发 retriage
CGAO 自己同步的 label 不直接触发状态迁移
self-echo 事件被标记 observed
```

### [x] T-M1-005 实现事件总线发布与 DLQ

Spec：第 8、10 节  
优先级：P0  
依赖：T-M1-003

产物：

```text
EventBus abstraction
NATS/Redis/Kafka adapter
DLQ topic
retry policy
```

验收：

```text
业务事件可发布/消费
消费失败进入重试
超过阈值进入 DLQ 并产生告警
```

### [x] T-M1-006 Webhook replay 与伪造测试

Spec：第 6、12.1、21 节  
优先级：P0  
依赖：T-M1-001, T-M1-002, T-M1-004

产物：

```text
tests/security/webhook-replay.test.ts
tests/security/forged-marker.test.ts
```

验收：

```text
重放 delivery 不产生重复状态迁移
伪造 cgao marker 无法改变状态
无效签名无法入队
```

## 6. M2：状态机、Artifact 与 hash 绑定

### [x] T-M2-001 实现 PostgreSQL schema

Spec：第 15 节  
优先级：P0  
依赖：T-M0-001

产物：

```text
workflow_runs
workflow_events
github_deliveries
github_mutations
command_authorizations
agent_runs
artifacts
gate_results
review_findings
policy_decisions
audit_records
```

验收：

```text
migration 可重复执行
核心表存在唯一索引和外键
```

### [x] T-M2-002 实现 workflow run 创建与锁

Spec：第 9、15 节  
优先级：P0  
依赖：T-M2-001

产物：

```text
WorkflowRunRepository
per-run advisory lock
optimistic version update
```

验收：

```text
同一 run_id 状态迁移串行
并发事件不会造成状态回退或重复 PR 创建
```

### [x] T-M2-003 实现 generation 与 material change 判断

Spec：第 9.4、9.5 节  
优先级：P0  
依赖：T-M2-002

产物：

```text
IssueSnapshotService
MaterialChangeDetector
current_issue_snapshot_sha
current_generation
```

验收：

```text
issue body/title 关键变化会生成新 generation
旧 generation 事件进入 stale_event
非关键 label 投影变化不增加 generation
```

### [x] T-M2-004 实现 Artifact Store abstraction

Spec：第 11、15 节  
优先级：P0  
依赖：T-M2-001

产物：

```text
ArtifactWriter
ArtifactReader
sha256 content addressing
classification
```

验收：

```text
Artifact 不可变
同内容 hash 稳定
Artifact metadata 写入 DB
```

### [x] T-M2-005 实现 artifact redaction baseline

Spec：第 11、20 节  
优先级：P0  
依赖：T-M2-004

产物：

```text
SecretRedactor
PiiRedactor
HighEntropyScanner
classification policy
```

验收：

```text
测试日志中的 token/env secret 被脱敏
security_sensitive artifact 不会被写入 GitHub comment
```

### [x] T-M2-006 实现 spec/plan/approval/test/review/merge hash 绑定

Spec：第 4.5、9.5、10、15 节  
优先级：P0  
依赖：T-M2-001, T-M2-003, T-M2-004

产物：

```text
HashBindingService
GateGuard
stale event handler
```

验收：

```text
spec、plan、approval、test、review、merge 均绑定 sha
issue material change 后旧事件自动 stale
PR synchronize 后旧 test/review/approval 失效
```

### [x] T-M2-007 实现 audit hash chain

Spec：第 19 节  
优先级：P1  
依赖：T-M2-001

产物：

```text
AuditWriter
canonical JSON serializer
record_hash / previous_hash
```

验收：

```text
任一 audit record 修改可被 hash chain 检出
policy decision、command authorization、merge decision 都写 audit
```

## 6.5 M-INTAKE：Issue Intake 模块（v3 新增）

### [x] T-INTAKE-001 飞书 Bot 接入

Spec：cgao_spec_v3.md §12.0、§17.4  
优先级：P0  
依赖：T-M2-001, T-M2-004

产物：

```text
apps/orchestrator/src/modules/intake/adapters/lark.ts
LarkAdapter.verifySignature / normalizeEvent / extractMentions / sendMessage
.github/workflows/cgao-intake-lark.yml（runs-on: cgao-trusted-runner）
```

验收：

```text
能接收群消息并识别 @bot
能读取消息线程上下文
签名验证只在 Trusted Control Runner 执行
```

### [x] T-INTAKE-002 WeCom Bot 接入

Spec：cgao_spec_v3.md §12.0、§17.5  
优先级：P0  
依赖：T-M2-001, T-M2-004

产物：

```text
apps/orchestrator/src/modules/intake/adapters/wecom.ts
WecomAdapter 同 LarkAdapter 接口
.github/workflows/cgao-intake-wecom.yml（runs-on: cgao-trusted-runner）
```

验收：

```text
msg_signature 校验只在 Trusted Control Runner 执行
WECOM_CORP_ID / WECOM_AGENT_SECRET 仅 Trusted Control Runner 可见
```

### [x] T-INTAKE-003 显式触发关键词词典 + LLM 兜底

Spec：cgao_spec_v3.md §12.0 Tier 1  
优先级：P0  
依赖：T-INTAKE-001, T-INTAKE-002

产物：

```text
apps/orchestrator/src/modules/intake/classifier.ts (isExplicitTrigger)
可配置关键词词典（.cgao.yml intake.sources.{lark,wecom}.triggers.explicit_keywords）
LLM 兜底（处理 typo / 关键词变体）
```

验收：

```text
显式 @bot + 关键词识别准确率 ≥ 95%
关键词词典可在 .cgao.yml 覆盖
```

### [x] T-INTAKE-004 LLM 软判定 pipeline（confidence 评分）

Spec：cgao_spec_v3.md §12.0 Tier 2 / Tier 3  
优先级：P0  
依赖：T-INTAKE-003

产物：

```text
apps/orchestrator/src/modules/intake/classifier.ts (Classifier.classify)
untrusted content envelope 集成
confidence_threshold / max_clarify_rounds 配置消费
返回 { confidence, category_hint, severity_hint }
```

验收：

```text
LLM precision ≥ 0.85（避免 issue 风暴）
LLM recall ≥ 0.6（允许漏报，由显式 @bot 兜底）
classifier 默认 sonnet；显式触发 fast path 可降级 haiku
输出为 advisory classification_hint，不设权威 label
```

### [x] T-INTAKE-005 IM 内多轮反问状态机（≤5 轮，类 deep-interview）

Spec：cgao_spec_v3.md §12.0 Tier 3  
优先级：P0  
依赖：T-INTAKE-004

产物：

```text
apps/orchestrator/src/modules/intake/clarifier.ts (Clarifier)
per-session state machine: pending → confirming → ready | dropped
max_clarify_rounds = 5（默认）
inactivity_timeout = 24h（默认）
cgao-intake-timeout-sweeper（每小时跑一次，dropped 陈旧 confirming session）
IM 反问 prompt 模板（参考 OMC deep-interview 风格，IM 简短版）
```

验收：

```text
≤5 轮内 confidence ≥ threshold → ready
≤5 轮内用户放弃 → dropped
24h 不活跃 → dropped（reason=inactivity_timeout）
intake_messages 仅写 PostgreSQL，不写 Artifact
```

### [x] T-INTAKE-006 去重幂等（dedup_key 三元组）

Spec：cgao_spec_v3.md §12.0、§15  
优先级：P0  
依赖：T-M2-001

产物：

```text
apps/orchestrator/src/modules/intake/dedup.ts (Deduplicator)
dedup_key = source_type|external_id|content_hash
24h 窗口（可配置 intake.dedup.window_minutes）
unique(dedup_key) DB 约束
```

验收：

```text
同一 dedup_key 24h 内只产生 1 个 issue
重复触发返回既有 issue 链接（HTTP 200，body 携带 existing_issue URL）
```

### [x] T-INTAKE-007 Untrusted content envelope 集成

Spec：cgao_spec_v3.md §6、§12.0、cgao_spec_v2.md §12.4  
优先级：P0  
依赖：T-M4-002

产物：

```text
apps/orchestrator/src/modules/intake/envelope.ts
wrapUntrusted / scanForInjection（复用 MOD-ANALYSIS 实现）
集成到 classifier.ts 和 clarifier.ts 的 LLM 调用路径
```

验收：

```text
所有 IM 消息正文必须经 untrusted envelope 进入 LLM
prompt injection fixture 不能改变 LLM 行为或建 issue 结果
```

### [x] T-INTAKE-008 Trusted Control Runner 调用 GitHub API 建 issue（advisory，不 bypass MOD-ISSUE）

Spec：cgao_spec_v3.md §12.0、§13.1、§17.4、§17.5  
优先级：P0  
依赖：T-M5-003, T-INTAKE-006, T-INTAKE-007

产物：

```text
apps/orchestrator/src/modules/intake/issuer.ts (IssueCreator)
  - 不直接调用 GitHub API
  - 发出 intake.issue.create_requested 事件
.github/workflows/cgao-intake-issue-create.yml（Trusted Control Runner job）
  - 消费 intake.issue.create_requested
  - 调用 GitHub API 建 issue
  - 仅设 cgao:new + intake:im label
  - body 内嵌 cgao metadata + classification_hint（advisory）
issue body template（包含 intake_session_id / source / external_id / hint）
```

验收：

```text
建 issue 动作只能通过 Trusted Control Runner 完成
Intake 路径不设 bug/feature/security 等权威 label
issue.created 事件触发 MOD-ISSUE 进行 authoritative triage
MOD-ISSUE 在 audit_records 写 accept_hint 或 override_hint
```

### [x] T-INTAKE-009 `.cgao.yml` intake 配置 schema

Spec：cgao_spec_v3.md §18  
优先级：P1  
依赖：T-M0-005

产物：

```text
apps/orchestrator/src/config/cgao_yml_schema.ts (扩展 intake 块)
apps/orchestrator/src/config/defaults.ts
fixtures/config/intake_modes.yml（auto/confirm/off 三种）
```

验收：

```text
intake.mode 支持 auto | confirm | off，默认 confirm
invalid mode 或 missing required field 被拒绝
```

### [x] T-INTAKE-010 Intake prompt injection 回归测试

Spec：cgao_spec_v3.md §6、§21  
优先级：P0  
依赖：T-INTAKE-007, T-INTAKE-008

产物：

```text
tests/security/intake/fixtures/prompt_injection_im.json
tests/security/intake/fixtures/spoofed_sender.json
tests/security/intake/fixtures/llm_hallucination.json
tests/security/intake/test_prompt_injection.py
tests/security/intake/test_sender_spoofing.py
tests/security/intake/test_llm_hallucination.py
```

验收：

```text
prompt injection 无法改变 LLM 行为或绕过建 issue gate
spoofed display_name 不能让 sender_github_login 自动填充
mode=confirm 默认开启，hallucination 用户可 IM 内取消
```

### [x] T-INTAKE-011 Intake dedup 重放回归测试

Spec：cgao_spec_v3.md §6、§12.0、§21  
优先级：P0  
依赖：T-INTAKE-006

产物：

```text
tests/security/intake/fixtures/replayed_webhook.json
tests/security/intake/fixtures/spam_burst.json (100 条相似消息)
tests/security/intake/fixtures/cross_platform_identity.json
tests/security/intake/fixtures/bot_token_leak.json
tests/security/intake/test_dedup_replay.py
tests/security/intake/test_rate_limit_dos.py
tests/security/intake/test_cross_platform_identity.py
tests/security/intake/test_token_isolation.py
```

验收：

```text
replay 同一 webhook 10 次只产生 1 个 issue
100 条相似消息被 dedup 拦截 ≥ 95%，intake_sessions ≤ 5
跨平台 sender 自动视为不同 identity，不自动合并
bot token 不出现在 artifact / 日志 / audit
```

## 7. M3：Issue 管理与命令授权

### [x] T-M3-001 实现 Issue triage rule engine

Spec：第 12.3 节  
优先级：P0  
依赖：T-M1-003, T-M2-002

产物：

```text
IssueClassifier
InformationCompletenessRules
StatusProjectionService
```

验收：

```text
bug/feature/docs/question/security/chore 分类可用
信息不足进入 NEEDS_INFO
关闭 issue 不进入开发流程
```

### [x] T-M3-002 实现 status comment 管理

Spec：第 14.2 节  
优先级：P0  
依赖：T-M1-004, T-M3-001

产物：

```text
StatusCommentRepository
comment_id storage
marker generator
comment updater
```

验收：

```text
同一 run 只有一条 active status comment
更新 comment 时校验 author 是 CGAO App bot
伪造 marker 不影响状态
```

### [x] T-M3-003 实现 label projection

Spec：第 14.1 节  
优先级：P0  
依赖：T-M1-004, T-M3-001

产物：

```text
LabelProjectionService
cgao:* label map
```

验收：

```text
内部状态变化后 label 被同步
人工改 cgao label 只触发 reconciliation signal，不直接改变状态
```

### [x] T-M3-004 实现 command parser

Spec：第 12.3、14.3 节  
优先级：P0  
依赖：T-M1-003

产物：

```text
CommandParser
command grammar
command event schema
```

验收：

```text
只解析 issue_comment.created
issue_comment.edited 中新增命令无效
未知命令返回明确提示
```

### [x] T-M3-005 实现强命令授权

Spec：第 12.3、14.3、15 节  
优先级：P0  
依赖：T-M3-004

产物：

```text
CommandAuthorizationService
GitHub permission resolver
command_authorizations table writer
```

验收：

```text
非授权 actor 的 /approve-plan 被拒绝
授权结果包含 actor、permission、source_comment_id、reason
授权记录写 audit
```

### [x] T-M3-006 实现 plan_id@plan_sha approval

Spec：第 12.3、12.5、14.3 节  
优先级：P0  
依赖：T-M2-006, T-M3-005

产物：

```text
PlanApprovalService
PlanHashMatcher
ApprovalArtifact
```

验收：

```text
/approve-plan 必须携带 plan_id@sha
plan_id 或 sha 不匹配时拒绝
旧 generation 的 approve 命令无效
```

### [x] T-M3-007 Prompt injection issue fixture tests

Spec：第 6、12.4、21 节  
优先级：P0  
依赖：T-M3-001, T-M3-004

产物：

```text
tests/security/prompt-injection-issue.test.ts
fixtures/malicious-issue-body.md
```

验收：

```text
issue body 中的“忽略系统提示”“运行 env”不能改变 agent policy
恶意 marker 不能改变状态
```

## 8. M4：需求分析与规划

### [x] T-M4-001 实现 RequirementSpec generator

Spec：第 12.4 节  
优先级：P0  
依赖：T-M2-004, T-M3-001

产物：

```text
AnalysisPromptTemplate
RequirementSpec schema
RequirementSpec validator
```

验收：

```text
生成 goals/non_goals/acceptance_criteria/risks/open_questions
each spec 绑定 issue_snapshot_sha
open_questions 非空时回到 NEEDS_INFO
```

### [x] T-M4-002 实现不可信内容包装

Spec：第 6、12.4 节  
优先级：P0  
依赖：T-M4-001

产物：

```text
UntrustedContentEnvelope
PromptAssembler
```

验收：

```text
issue/comment 内容只出现在 untrusted content 区域
系统指令与用户内容有明确边界
prompt injection regression 通过
```

### [x] T-M4-003 实现 deterministic risk classifier

Spec：第 12.11、18 节  
优先级：P0  
依赖：T-M4-001

产物：

```text
RiskClassifier
ProtectedPathRules
DependencyChangeRules
```

验收：

```text
auth/payment/infra/.github/.cgao/.claude/dependency 文件触发 high 或 critical
LLM 不能降低 deterministic risk
```

### [x] T-M4-004 实现 ImplementationPlan generator

Spec：第 12.5 节  
优先级：P0  
依赖：T-M4-001, T-M4-003

产物：

```text
PlanPromptTemplate
ImplementationPlan schema
PlanValidator
```

验收：

```text
所有 acceptance criteria 映射到 task
每个 task 有 allowed_paths/forbidden_paths/depends_on/agent/model_tier
plan 生成 sha256
```

### [x] T-M4-005 实现 plan comment 与审批提示

Spec：第 12.5、14.2、14.3 节  
优先级：P0  
依赖：T-M3-002, T-M4-004

产物：

```text
PlanCommentRenderer
ApprovalCommandHint
```

验收：

```text
issue comment 展示 /approve-plan plan_id@plan_sha
status comment 更新不刷屏
```

### [x] T-M4-006 实现 handoff artifact schema

Spec：第 5、11、12.6 节  
优先级：P1  
依赖：T-M2-004

产物：

```text
Handoff schema
handoff writer
handoff reader
```

验收：

```text
analysis→plan、plan→dev、dev→review 都可生成 handoff
reviewer 默认不读取 executor 自我辩护全文
```

## 9. M5：Runner 隔离与开发模块

### [x] T-M5-001 实现 Runner Broker

Spec：第 8、13、16 节  
优先级：P0  
依赖：T-M2-004, T-M4-004

产物：

```text
RunnerBroker
AgentRunQueue
AgentRun API
```

验收：

```text
可创建 agent run
agent run 记录 role/model/task/input_artifact/output_artifact
失败可重试并写 audit
```

### [x] T-M5-002 接入 Claude Code Action baseline

Spec：第 17 节  
优先级：P0  
依赖：T-M5-001

产物：

```text
.github/workflows/cgao-claude-runner.yml
repository_dispatch trigger
prompt artifact loader
```

验收：

```text
可触发 analyst/planner/executor/reviewer 基础任务
runner 输出写回 artifact
```

### [x] T-M5-003 拆分 trusted control runner 与 untrusted code runner

Spec：第 8、13、17 节  
优先级：P0  
依赖：T-M5-001

产物：

```text
TrustedControlRunner workflow/profile
UntrustedCodeRunner workflow/profile
CredentialProfileService
```

验收：

```text
执行仓库代码的 job 无 GitHub 写 token
执行仓库代码的 job 无 Anthropic key
执行仓库代码的 job 无 artifact write token
GitHub 写操作只能通过 trusted control path
```

### [x] T-M5-004 实现 no-secret runner profile

Spec：第 13.1、13.3、20 节  
优先级：P0  
依赖：T-M5-003

产物：

```text
NoSecretExecutionProfile
EnvScrubber
TokenPresenceTest
```

验收：

```text
测试 job 中不存在 GitHub 写 token、Anthropic key、cloud secret
恶意测试打印 env 时无敏感值
```

### [x] T-M5-005 实现 filesystem sandbox baseline

Spec：第 13.3 节  
优先级：P0  
依赖：T-M5-003

产物：

```text
ReadOnlyBaseCheckout
WriteOverlay
PathWritePolicy
```

验收：

```text
forbidden path 在执行期不可写
allowed path 内脚本无法修改 forbidden path
sandbox violation 进入 POLICY_DENIED
```

### [x] T-M5-006 实现 clean checkout validation

Spec：第 12.6、13.3 节  
优先级：P0  
依赖：T-M5-005

产物：

```text
PatchExporter
PatchValidator
CleanCheckoutApplier
```

验收：

```text
agent 结束后只输出 patch
测试在 clean checkout + validated patch 上运行
脏 workspace 不直接进入测试或 PR
```

### [x] T-M5-007 实现 protected file policy

Spec：第 12.11、18 节  
优先级：P0  
依赖：T-M4-003, T-M5-006

产物：

```text
ProtectedFileDetector
RiskEscalationHook
```

验收：

```text
.cgao/**、.claude/**、.github/**、package manifests、lockfiles、scripts/** 变更自动 high/critical
protected file 变更禁止自动合入
```

### [x] T-M5-008 实现开发模块主流程

Spec：第 12.6 节  
优先级：P0  
依赖：T-M5-001, T-M5-006

产物：

```text
DevelopmentModule
TaskRunner
PatchAggregator
```

验收：

```text
plan.approved 后可启动 executor task
输出 WorkerResult artifact
失败可进入 dev.failed 或 fix.requested
```

### [x] T-M5-009 Forbidden path escape 回归测试

Spec：第 6、13.3、21 节  
优先级：P0  
依赖：T-M5-005, T-M5-006

产物：

```text
tests/security/forbidden-path-escape.test.ts
fixtures/malicious-repo-write-forbidden/
```

验收：

```text
allowed path 内脚本尝试修改 .github/workflows 被拒绝
测试失败不会泄露 secret
```

## 10. M6：测试与修复循环

### [x] T-M6-001 实现 fast gate runner

Spec：第 12.7 节  
优先级：P0  
依赖：T-M5-004, T-M5-006

产物：

```text
FastGateRunner
GateResult schema
lint/typecheck/unit adapters
```

验收：

```text
可运行 lint/typecheck/unit
结果绑定 head_sha/base_sha
日志写 artifact 并脱敏
```

### [x] T-M6-002 实现 failure fingerprint

Spec：第 12.7、20 节  
优先级：P0  
依赖：T-M6-001

产物：

```text
FailureParser
FingerprintService
```

验收：

```text
同类失败能稳定识别
fingerprint 写入 test-result artifact
```

### [x] T-M6-003 实现 UltraQA 风格修复循环

Spec：第 12.7、23 节  
优先级：P0  
依赖：T-M6-001, T-M6-002, T-M5-008

产物：

```text
TestFixLoopController
DebuggerAgentRun
FixAgentRun
```

验收：

```text
最多 5 轮修复
同一 fingerprint 3 次后 BLOCKED
每轮产生独立 test-result 和 fix-result artifact
```

### [x] T-M6-004 实现 package script exfiltration 回归测试

Spec：第 6、13.1、21 节  
优先级：P0  
依赖：T-M5-004, T-M6-001

产物：

```text
tests/security/package-script-exfiltration.test.ts
fixtures/malicious-package-json/
```

验收：

```text
恶意 npm test 无法读取 GitHub 写 token
恶意 npm test 无法读取 Anthropic key
恶意 npm test 无法访问 artifact write token
日志脱敏后无 secret
```

### [x] T-M6-005 实现 verifier 基础验收

Spec：第 12.7、12.9 节  
优先级：P1  
依赖：T-M6-001

产物：

```text
VerifierRunner
AcceptanceCriterionEvidence schema
```

验收：

```text
每条 acceptance criterion 有 test/review/manual evidence
PR body checkbox 不作为 gate 证据
```

## 11. M7：Commit 与 PR

### [ ] T-M7-001 实现工作分支创建

Spec：第 12.8 节  
优先级：P0  
依赖：T-M5-008

产物：

```text
BranchService
branch naming policy
```

验收：

```text
可创建 cgao/issue-<n>-<slug>
重复执行不会创建多条同义分支
```

### [ ] T-M7-002 实现 commit 生成

Spec：第 12.8 节  
优先级：P0  
依赖：T-M5-006, T-M7-001

产物：

```text
CommitBuilder
CommitMessageRenderer
```

验收：

```text
commit message 包含 issue、run_id、spec_id、plan_id
commit 前执行 protected file policy
```

### [ ] T-M7-003 实现 PR 创建与去重

Spec：第 12.8、15 节  
优先级：P0  
依赖：T-M7-002

产物：

```text
PullRequestService
unique active PR per run constraint
PR marker
```

验收：

```text
重复事件和并发 retry 不会创建重复 PR
PR number 写入 workflow_runs
```

### [ ] T-M7-004 实现 PR body traceability

Spec：第 12.8、14.2 节  
优先级：P0  
依赖：T-M7-003

产物：

```text
PRBodyRenderer
TraceabilityBlock
```

验收：

```text
PR body 展示 issue、run_id、spec_id、plan_id、head_sha、测试摘要
PR body 不暴露内部 artifact URI
```

### [ ] T-M7-005 实现 dependency change policy

Spec：第 12.11、18 节  
优先级：P1  
依赖：T-M5-007, T-M7-002

产物：

```text
DependencyChangeDetector
License/SCA hook adapter
```

验收：

```text
新增依赖触发 human approval
manifest/lockfile 变更自动 high risk
新增 preinstall/postinstall script 标记 critical
```

### [ ] T-M7-006 实现 PR duplicate/race 回归测试

Spec：第 4.3、4.4、15 节  
优先级：P0  
依赖：T-M7-003

产物：

```text
tests/concurrency/pr-duplicate-race.test.ts
```

验收：

```text
重复 webhook + retry + timeout 并发下只有一个 PR
DB unique constraint 和 advisory lock 生效
```

## 12. M8：审查模块

### [ ] T-M8-001 实现 code-reviewer runner

Spec：第 12.9、13.2 节  
优先级：P1  
依赖：T-M7-003

产物：

```text
CodeReviewPrompt
ReviewResult schema
ReviewRunner
```

验收：

```text
审查结果绑定 head_sha
实现 agent 不参与最终 approval
review comment 经 trusted broker 写入 GitHub
```

### [ ] T-M8-002 实现 security-reviewer runner

Spec：第 12.9 节  
优先级：P1  
依赖：T-M8-001

产物：

```text
SecurityReviewPrompt
SecurityFinding schema
```

验收：

```text
auth/payment/secret/input validation 相关变更触发安全审查
security finding 可标记 blocking
```

### [ ] T-M8-003 实现 review_findings 存储

Spec：第 12.9、15 节  
优先级：P1  
依赖：T-M8-001

产物：

```text
ReviewFindingRepository
finding_hash generator
```

验收：

```text
finding_hash 稳定
finding 绑定 head_sha
blocking finding 可查询
```

### [ ] T-M8-004 实现 finding lifecycle

Spec：第 12.9 节  
优先级：P1  
依赖：T-M8-003

产物：

```text
FindingLifecycleService
fixed/dismissed workflow
```

验收：

```text
blocking finding 不能因新 review 漏报自动关闭
fixed 需要同类 reviewer 在新 head_sha 上明确确认
dismissed 需要 maintainer reason
```

### [ ] T-M8-005 实现 reviewer context isolation

Spec：第 5、12.9 节  
优先级：P1  
依赖：T-M4-006, T-M8-001

产物：

```text
ReviewerContextBuilder
HandoffFilter
```

验收：

```text
reviewer 默认读取 RequirementSpec、ImplementationPlan、diff、test evidence
reviewer 不默认读取 executor 的完整自我解释
```

## 13. M9：合入模块

### [ ] T-M9-001 实现 gate aggregation

Spec：第 12.10、15 节  
优先级：P1  
依赖：T-M6-001, T-M8-003

产物：

```text
GateAggregator
gate_results reader
PolicyDecision writer
```

验收：

```text
测试、AI review、人类 review、risk policy 可汇总
所有 gate 绑定 head_sha/base_sha
```

### [ ] T-M9-002 实现 SHA-bound final evaluator

Spec：第 12.10、21、23 节  
优先级：P0  
依赖：T-M2-006, T-M9-001

产物：

```text
MergeFinalEvaluator
GitHubStateHydrator
MergeDecision artifact
```

验收：

```text
合入前重新读取 GitHub 当前 PR 状态
current_head_sha 与 tested/reviewed/approved head_sha 不一致时拒绝
base 不一致时要求重新测试或进入 merge queue
```

### [ ] T-M9-003 实现 merge-ready comment

Spec：第 12.10、14.2 节  
优先级：P1  
依赖：T-M9-002

产物：

```text
MergeReadyRenderer
status comment update
```

验收：

```text
满足 gate 时发布 merge-ready 摘要
不暴露 internal artifact URI
```

### [ ] T-M9-004 实现 merge execution baseline

Spec：第 12.10 节  
优先级：P1  
依赖：T-M9-002

产物：

```text
MergeService
BranchProtectionChecker
IssueCloseService
```

验收：

```text
merge-manager token 不具备 bypass branch protection 权限
高风险 PR 缺少人工 review 时拒绝 merge
合入后关闭 issue 并清理 cgao label
```

### [ ] T-M9-005 实现 stale SHA merge prevention 回归测试

Spec：第 6、12.10、21 节  
优先级：P0  
依赖：T-M9-002

产物：

```text
tests/security/stale-sha-merge-prevention.test.ts
```

验收：

```text
PR force-push 后旧测试/旧 review/旧 approval 无效
base branch 前进后不得直接 merge
final evaluator 拒绝 stale gates
```

### [ ] T-M9-006 merge queue 支持

Spec：第 12.10、17 节  
优先级：P2  
依赖：T-M9-002

产物：

```text
MergeQueueAdapter
merge_group event handler
```

验收：

```text
required checks 可在 merge_group 上运行
merge queue 通过后可完成归档
```

## 14. M10：Reconciler、审计与运营

### [ ] T-M10-001 实现 active run reconciler

Spec：第 12.2 节  
优先级：P1  
依赖：T-M2-002, T-M7-003, T-M9-001

产物：

```text
ReconcilerScheduler
GitHubHydrator
DriftDetector
```

验收：

```text
服务停机期间的 issue/PR/check/review 变化可恢复
DB 与 GitHub drift 可自动发现并生成修复事件
```

### [ ] T-M10-002 实现 comment/label reconciliation

Spec：第 12.2、14.1、14.2 节  
优先级：P1  
依赖：T-M10-001

产物：

```text
ProjectionReconciler
StatusCommentReconciler
LabelReconciler
```

验收：

```text
status comment 被删后可重建
label 投影被人工改错后可恢复
```

### [ ] T-M10-003 实现 observability baseline

Spec：第 19 节  
优先级：P1  
依赖：T-M1-005, T-M2-001

产物：

```text
structured logging
OpenTelemetry traces
Prometheus metrics
```

验收：

```text
run_id/event_id/module/state_from/state_to/reason 出现在日志中
核心指标可采集
```

### [ ] T-M10-004 实现成本与限流控制

Spec：第 12.11、18、19 节  
优先级：P1  
依赖：T-M5-001

产物：

```text
BudgetService
RateLimiter
ActorQuotaService
```

验收：

```text
每 repo 每小时 agent run 有上限
外部 actor 每日触发有上限
预算耗尽进入 WAITING_BUDGET_APPROVAL
```

### [ ] T-M10-005 实现 artifact retention 与访问控制

Spec：第 11、15、19 节  
优先级：P1  
依赖：T-M2-004, T-M2-005

产物：

```text
ArtifactAccessPolicy
RetentionScheduler
```

验收：

```text
public_summary/internal_log/security_sensitive/audit_restricted 分类生效
过期 artifact 可归档或删除
```

### [ ] T-M10-006 实现 audit checkpoint

Spec：第 19 节  
优先级：P1  
依赖：T-M2-007

产物：

```text
AuditCheckpointWriter
ImmutableStorageAdapter
```

验收：

```text
audit hash chain checkpoint 可写入外部不可变存储
checkpoint 可用于验证历史记录未被篡改
```

## 15. M11：生产增强

### [ ] T-M11-001 Agent SDK Runner

Spec：第 13、16 节  
优先级：P2  
依赖：T-M5-001, T-M5-003

产物：

```text
AgentSDKRunner
streaming output collector
runner hook integration
```

验收：

```text
可不依赖 GitHub Actions 执行 agent run
权限、hooks、artifact、日志统一受 Orchestrator 控制
```

### [ ] T-M11-002 并行 worktree 执行

Spec：第 5、12.6 节  
优先级：P2  
依赖：T-M5-008, T-M7-001

产物：

```text
WorktreeManager
TaskMergeController
ConflictResolver
```

验收：

```text
多个 task 可并行执行
冲突进入 CONFLICTED 或 debugger fix
```

### [ ] T-M11-003 多仓库支持

Spec：第 8、15 节  
优先级：P2  
依赖：T-M10-001

产物：

```text
RepositoryRegistry
InstallationResolver
per-repo policy cache
```

验收：

```text
多个 GitHub App installation 可隔离运行
repo policy 不串扰
```

### [ ] T-M11-004 Dashboard

Spec：第 19 节  
优先级：P2  
依赖：T-M10-003

产物：

```text
workflow run list
run detail page
gate status page
cost page
```

验收：

```text
可查看 active runs、blocked runs、cost、failure fingerprints、merge decisions
```

## 16. 跨模块安全测试计划

### P0 安全测试

| 测试 | 覆盖风险 | 对应任务 |
|---|---|---|
| webhook replay | 重放导致重复状态迁移 | T-M1-006 |
| forged marker | 用户伪造系统 comment marker | T-M1-006, T-M3-002 |
| unauthorized command | 非授权 actor 执行 /approve-plan | T-M3-005 |
| stale plan approval | 旧 plan_sha 被批准 | T-M3-006 |
| prompt injection issue | issue body 变成模型指令 | T-M3-007, T-M4-002 |
| forbidden path escape | allowed path 脚本写 forbidden path | T-M5-009 |
| package script exfiltration | npm test 读取 secret | T-M6-004 |
| duplicate PR race | 并发创建重复 PR | T-M7-006 |
| stale SHA merge | 旧测试/审查被复用合入 | T-M9-005 |
| intake prompt injection | IM 正文注入系统指令 | T-INTAKE-010 |
| intake sender spoofing | display_name 伪造身份 | T-INTAKE-010 |
| intake llm hallucination | LLM 生成与用户意图不符的 issue | T-INTAKE-010 |
| intake webhook replay | IM webhook 重放产生重复 issue | T-INTAKE-011 |
| intake rate/cost DoS | IM 群组刷屏触发 LLM 风暴 | T-INTAKE-011 |
| intake cross-platform identity | 同一人在多平台被错误合并 | T-INTAKE-011 |
| intake token leak | bot token / App secret 通过日志或 artifact 泄露 | T-INTAKE-011 |
| artifact redaction | 日志泄露 secret | T-M2-005 |

### P1 稳定性测试

| 测试 | 覆盖风险 | 对应任务 |
|---|---|---|
| service downtime reconciliation | 停机期间状态漂移 | T-M10-001 |
| label/comment drift | GitHub 投影被人工改错 | T-M10-002 |
| blocking finding lifecycle | 漏报关闭 blocking finding | T-M8-004 |
| budget exhaustion | 成本 DoS | T-M10-004 |
| artifact retention | 敏感 artifact 过期治理 | T-M10-005 |

## 17. 总体验收标准

MVP 完成时必须满足：

```text
1. issue opened 后可自动 triage、生成 RequirementSpec、生成 ImplementationPlan。
2. /approve-plan 必须带 plan_id@plan_sha，旧 sha 或未授权 actor 无效。
3. Claude executor 只能在 sandbox 中生成 patch。
4. 测试在 clean checkout + validated patch 上运行。
5. 执行仓库代码的 runner 无 GitHub 写 token、无 Anthropic key、无长期 secret。
6. fast gate 结果绑定 head_sha/base_sha。
7. PR 创建具备幂等性，并绑定 run_id/spec_id/plan_id/head_sha。
8. code-reviewer 和 security-reviewer 可输出结构化 finding。
9. blocking finding 不能因漏报自动关闭。
10. 合入前 final evaluator 重新读取 GitHub 当前状态。
11. PR synchronize 后旧测试、旧审查、旧审批失效。
12. 系统自己写 comment/label 不触发业务循环。
13. Reconciler 能发现 GitHub/DB drift。
14. P0 安全回归测试全部通过。
15. 所有 policy decision、command authorization、merge decision 写入 audit。
```

## 18. 风险与阻塞清单

| 风险 | 等级 | 缓解 |
|---|---:|---|
| Runner secret 泄露 | P0 | no-secret runner、trusted/untrusted split、exfiltration test |
| 旧测试/旧 review 被合入复用 | P0 | SHA-bound gates、final evaluator |
| Prompt injection | P0 | untrusted content envelope、policy in code、regression tests |
| GitHub webhook 漏投/乱序 | P1 | reconciler、state guard、hydrate current state |
| Claude 修改策略文件降权 | P0 | protected file policy、risk escalation |
| 外部 PR artifact 污染 | P0 | external PR read-only、artifact source validation |
| 成本 DoS | P1 | rate limit、budget gate、actor quota |
| 审计被篡改 | P1 | audit hash chain、checkpoint |

## 19. 建议迭代顺序

```text
1. M0 + M1：先把事件入口和安全测试框架搭起来。
2. M2：实现状态源、artifact、hash 绑定，这是后续模块的地基。
3. M3 + M4：完成 issue→spec→plan→approval 的闭环。
4. M5：接入 Claude runner，同时完成权限域拆分和 sandbox。
5. M6：完成 no-secret fast gate 和 P0 安全回归测试。
6. M7：实现 PR 创建和去重。
7. M8：实现 AI review 和 finding lifecycle。
8. M9：实现 final evaluator，进入真实仓库试点。
9. M10：补齐 reconciler、观测、成本和审计。
10. M11：再做 SDK runner、并行 worktree 和多仓库扩展。
```
