# CGAO 系统规格说明书 v3

文档状态：Draft 3.0  
日期：2026-07-03  
系统名称：CGAO — Claude GitHub Automation Orchestrator  
关联任务清单：`cgao_tasklist_v3.md`  
关联变更记录：`cgao_v3_changelog.md`  
关联访谈 spec：`.omc/specs/deep-interview-cgao-intake-extension.md`（ambiguity 14.55%，PASSED）  
上一版本：`cgao_spec_v2.md`（`cgao_v2_changelog.md`）

## 0. 修订摘要

### 0.1 v2 修订摘要（保留）

本版本把红蓝军挑战结果合并进系统规格。v1 的主干流程保留，v2 对安全边界、状态版本、runner 权限、命令授权、合入判定和恢复机制做了硬化。

v2 的关键变化如下：

1. 将所有 GitHub issue、comment、PR body、review comment、workflow artifact 明确定义为不可信输入。
2. 将 Claude runner 拆成【可信控制域】和【不可信代码执行域】。
3. 所有 gate 绑定 `issue_snapshot_sha`、`spec_sha`、`plan_sha`、`approval_sha`、`head_sha` 和 `base_sha`。
4. `/approve-plan` 改为版本绑定命令，必须携带 `plan_id@plan_sha`。
5. GitHub comment marker 只作为展示辅助，不作为状态认证依据。
6. 增加 origin suppression，防止系统自己写 comment / label 后再次触发业务循环。
7. 增加 reconciler，用于修复 webhook 漏投、乱序、服务停机和 GitHub/DB 状态漂移。
8. 增加 filesystem sandbox、clean checkout validation 和 no-secret test execution。
9. 保护 `.cgao/**`、`.claude/**`、`.github/**`、依赖清单、lockfile、package scripts、Dockerfile、Makefile 和 `scripts/**`。
10. 增加 SHA-bound merge final evaluator，合入前重新读取 GitHub 当前状态并重新计算 gate。

v2 的设计基线可以概括为：模型负责建议和执行受限任务；Orchestrator 负责状态与决策；Policy 负责拦截；Sandbox 负责隔离；GitHub branch protection / merge queue 负责最终交付约束；Artifact 和 Audit 负责追责。

### 0.2 v3 修订摘要（本次新增）

v3 在 v2 完整安全基线之上，新增 **MOD-INTAKE：Issue Intake 模块**，把飞书和企业微信（WeCom）IM 群里的口语化需求/bug 反馈，通过"显式触发 + LLM 软判定 + IM 内多轮反问"三层策略，转换为 well-formed GitHub issue 进入既有 pipeline。v3 的所有改动都是**追加性**的——不修改 v2 任何模块的行为，只新增入口路径。

v3 的关键变化如下：

1. 新增 `MOD-INTAKE`（§12.0），作为 v2 SDLC pipeline 的前置入口模块，仅处理 IM 源（飞书 + WeCom）。
2. 三层触发策略：显式 `@bot` 触发无条件建 issue；LLM 高 confidence 直接建 issue；LLM 低 confidence 在 IM 内多轮反问（≤5 轮，类 OMC deep-interview）。
3. 去重幂等键：`source_type | external_id | content_hash`，24h 窗口（可配置）。
4. **Intake 仅澄清到能建 issue，且分类为 advisory**：Intake 发出 `intake.issue.create_requested` 事件 → Trusted Control Runner 创建 GitHub issue（body 内嵌 `classification_hint`）→ 既有 `issue.created` 事件流入 MOD-ISSUE → MOD-ISSUE 进行 authoritative 分类（可接受或覆盖 hint）。**Intake 不 bypass MOD-ISSUE，不直接设置 `bug`/`feature` 等权威 label。**
5. IM 消息原文按 §6 untrusted content envelope 进入 LLM；所有 IM 来源内容均不可信。
6. Bot token / App secret 仅在 Trusted Control Runner 中持有；签名验证只在 Trusted Control Runner 执行。
7. 状态机前置：`INTAKE_RECEIVED → INTAKE_CONFIRMING → INTAKE_READY → NEW`（仅 IM 来源 run 走；GitHub 直接创建的 issue 跳过）。
8. 数据模型新增三张表：`intake_sessions`、`intake_messages`、`intake_decisions`。
9. `.cgao.yml` 新增 `intake` 配置块（`mode = auto | confirm | off`，默认 `confirm`）。
10. GitHub Actions 新增两个 intake webhook receiver workflow（飞书 / WeCom 各一），均运行于 Trusted Control Runner。

v3 的设计基线可以概括为：**v2 完整安全基线不变**（untrusted envelope、SHA-bound gates、Trusted Control Runner / Untrusted Code Runner 拆分、protected file policy、final evaluator、reconciler 等均照旧），MOD-INTAKE 仅作为松耦合的入口前置，通过事件总线与既有 pipeline 协作。

v3 **不在本轮引入**：Codex 作为执行 agent；监控告警源（Sentry / Grafana / Datadog）；外部工单系统（Jira / Linear / Asana / Notion）；CI/安全扫描适配器（Dependabot / code scanning / Snyk）。这些归 phase 2，详见 `cgao_v3_changelog.md`。

## 1. 背景

本系统面向基于 GitHub 的软件研发流程，目标是把 issue 作为需求入口，把 Claude Code 作为智能执行引擎，把 GitHub PR / Review / Check / Merge 作为协作与交付面，形成从 issue 创建到代码最终合入的自动化闭环。

系统采用松耦合架构。issue 管理、需求分析、开发实施、测试验证、提交建 PR、代码审查、合入管理等模块保持独立，通过标准化事件、Artifact 引用和状态机协作。任何模块不得依赖另一个模块的内部实现。

本规格参考 OMC（oh-my-claudecode）的组织方式：Hooks 负责生命周期触发，Skills 负责工作流能力注入，Agents 负责专业角色执行，State 负责跨会话状态延续。迁移到 GitHub 平台后，对应关系如下：

```text
OMC Hooks    → GitHub Webhook / Actions Event / Runner Hook / Policy Hook
OMC Skills   → Workflow Capability / Orchestration Policy
OMC Agents   → Claude Code Worker Role
OMC State    → Orchestrator State Store + Artifact Store + Audit Chain
OMC UltraQA  → 有界 test-fix-verification 循环
OMC Team     → 多 worker / worktree / handoff 协作模式
```

## 2. 目标

系统目标如下：

1. 自动接收 GitHub issue，并完成分类、状态判定和智能回复。
2. 自动判断 issue 是否具备需求分析条件；信息不足时生成可操作的补充问题。
3. 自动生成需求规格、验收标准、风险分类和实施计划。
4. 支持计划审批 gate，低风险任务可自动继续，高风险任务需人工确认。
5. 调用 Claude Code 完成开发实施，支持多 agent 角色、独立 workspace 和受限权限。
6. 自动运行测试、诊断失败、修复、复测，采用有界循环。
7. 自动生成 commit、创建或更新 PR，并维护 traceability。
8. 自动执行代码审查、安全审查和验收核对。
9. 根据风险策略、CI 结果、人类 review 和 AI review 结果决定是否进入 merge-ready。
10. 合入前执行 SHA-bound final evaluation，防止旧测试、旧 review 或旧 approval 被复用。
11. 合入后自动关闭 issue、清理状态、归档审计记录。
12. 通过 reconciler 修复 webhook 漏投、乱序、系统停机和 GitHub/DB drift。

## 3. 非目标

第一版生产试点不覆盖以下能力：

1. 不支持跨组织大规模批量迁移。
2. 不直接操作生产环境。
3. 不允许 Claude worker 读取或修改 secrets。
4. 不把 GitHub label、comment marker、PR body checkbox 作为内部状态源。
5. 不允许实现 agent 审查并最终批准自己的变更。
6. 不在 MVP 阶段支持任意第三方任务系统，如 Jira、Linear、Asana。
7. 不允许高风险变更在缺少人工 gate 时自动合入。
8. 不信任外部 PR 的 workflow artifact 作为控制输入。
9. 不允许测试 job 携带 GitHub 写 token、Anthropic key 或长期 secret。

## 4. 核心设计原则

### 4.1 松耦合

模块之间通过事件总线通信。模块只消费事件、读取 Artifact、写入新的事件或状态。除 Orchestrator 外，模块之间不得直接调用。

### 4.2 状态权威性

GitHub 是协作事实源，Orchestrator DB 是流程状态源。GitHub label、comment、PR body 只是投影。若出现冲突，以 Orchestrator DB 为准，再通过 GitHub API 重新同步投影。

### 4.3 事件只是触发器

Webhook payload 只作为触发信号。任何会影响状态转移的动作，都必须在处理时重新 hydrate GitHub 当前事实，包括 issue、PR、labels、reviews、checks、head SHA、base SHA、branch protection 和 merge queue 状态。

### 4.4 幂等

所有事件处理必须可重复执行。每个 GitHub delivery、内部 event、agent run、PR 创建、comment 更新、label 同步、merge decision 都必须具备幂等键。

### 4.5 SHA-bound gate

需求、计划、审批、实现、测试、审查和合入之间必须通过 hash 链绑定。旧 spec、旧 plan、旧测试、旧 review、旧 approval 不得驱动新 head 或新 base 的合入。

### 4.6 有界自治

自动修复、自动审查、自动合入均受策略控制。测试修复循环最多 5 轮，同一失败 fingerprint 出现 3 次后阻断。

### 4.7 角色隔离

需求分析、规划、开发、测试、代码审查、安全审查、合入判定必须使用不同角色。实现 agent 不能成为最终审批者。

### 4.8 最小权限

任何执行仓库代码的 runner job 不得携带 GitHub 写 token、Anthropic key、artifact write token 或长期 secret。所有写 GitHub 的动作必须通过 Orchestrator Broker 或可信控制域完成。

### 4.9 Artifact 优先

需求规格、计划、prompt、agent 输出、测试日志、审查发现、合入判定均保存为 Artifact。GitHub 评论只展示摘要和审计引用，不暴露内部 artifact URI。

### 4.10 安全规则写进代码

安全边界不得只写进 prompt。路径权限、命令权限、合入 gate、修复上限、外部 PR 策略、protected files、artifact 脱敏、final evaluator 都必须由代码强制执行。

## 5. OMC 设计映射

| OMC 机制 | 迁移后机制 | 说明 |
|---|---|---|
| Hooks | Webhook Gateway + Runner Hook + Policy Hook | 接收 GitHub 事件，在 runner 内拦截工具调用和输出 |
| Skills | Workflow Policy | issue triage、autopilot、ultraqa、review、merge 等流程能力 |
| Agents | Claude Worker Role | analyst、planner、executor、debugger、test-engineer、verifier、code-reviewer、security-reviewer、git-master |
| State | PostgreSQL + Artifact Store + Audit Chain | 跨事件、跨 runner、跨重试维持状态 |
| UltraQA | Test Fix Loop | 运行测试、诊断、修复、复测，有上限和 early stop |
| Team Worktree | Per-task Workspace / Worktree | 并行任务隔离编辑，主分支统一汇合 |
| Delegation Enforcer | Model/Role Policy Engine | 根据角色自动选择模型、工具权限、路径权限 |
| pre-tool-enforcer | Runner Policy Hook | 写文件、Bash、GitHub API 调用前做准入判断 |
| Handoff | Artifact Handoff | 阶段间只传递最小必要上下文，减少污染和漂移 |

OMC 的经验在本系统中的落点：hook 是硬控制，skill 是流程模板，agent 是权限受限的执行者，state 是恢复能力，handoff 是跨 agent 的最小上下文。

## 6. 安全威胁模型

### 6.1 资产

系统必须保护以下资产：

1. GitHub 写权限 token。
2. Anthropic API key 或其他模型供应商凭据。
3. artifact store 写凭据。
4. 仓库代码、分支、PR、review、merge 权限。
5. CI secret、部署 secret、云服务凭据。
6. 审计记录和 policy decision record。
7. 用户数据、日志中的敏感信息、内部路径和错误堆栈。

### 6.2 信任边界

| 来源 | 信任等级 | 处理方式 |
|---|---:|---|
| GitHub issue body | 不可信 | 只能作为需求材料，不能作为指令 |
| GitHub comment | 不可信 | 命令需校验 actor 权限和 comment created 事件 |
| PR body | 不可信展示 | 不作为验收证据 |
| PR diff | 不可信代码 | 只能在无 secret sandbox 中执行 |
| workflow artifact | 不可信或半可信 | 必须校验来源、head_sha、workflow_id、artifact sha |
| GitHub webhook payload | 触发信号 | 处理前重新 hydrate 当前状态 |
| Orchestrator DB | 内部状态源 | 使用事务、锁和 audit chain |
| Artifact Store | 内部证据源 | 写入前脱敏，按分类授权 |
| GitHub branch protection | 交付约束 | 合入前必须读取并记录实际状态 |
| IM 消息正文（飞书 / WeCom） | 不可信 | v3 新增。仅作为 intake 材料，必须经 untrusted envelope 进入 LLM；不可作为命令或策略输入 |
| IM sender display_name | 不可信 | v3 新增。仅作为展示，不可作为身份证据；身份只认 platform-issued user_id |
| IM webhook payload | 触发信号 | v3 新增。签名验证后归一化为 CloudEvents；处理时重新 hydrate 当前 repo 状态 |
| Intake `classification_hint` | 半可信 advisory | v3 新增。Intake 的 LLM 分类只是 hint，权威分类由 MOD-ISSUE 在 issue.created 后给出 |

### 6.3 红军攻击面

必须显式防护：

```text
Prompt injection
伪造 cgao marker
伪造 /approve-plan 命令
旧 plan / 旧 approval 被复用
重复 webhook 导致重复 PR 或重复评论
系统 comment / label 自激活循环
PR force-push 后复用旧测试结果
base branch 前进后复用旧 review
package script 读取 secret
allowed path 内脚本修改 forbidden path
外部 PR workflow artifact 污染
Claude 修改 .cgao.yml 或 .claude/settings 降低策略
依赖清单变更引入恶意包
workflow_run 在高权限上下文中执行不可信代码
merge-manager 绕过 branch protection
日志或 artifact 泄露 secret
批量 issue 触发成本 DoS
```

**v3 新增（IM 来源攻击面）：**

```text
IM 消息正文 prompt injection（包裹在 untrusted envelope 中）
IM 显示名 sender spoofing（display_name 不可作为身份证据）
IM webhook replay（同一条消息多次投递）
IM bot token / App secret 通过日志或 artifact 泄露
跨平台身份混淆（同一人在飞书和 WeCom 上有不同 sender_im_user_id）
IM 群组高频刷屏触发 LLM 成本 DoS
伪造 IM 投递试图绕过签名验证
Intake 路径试图直接设置权威 label 绕过 MOD-ISSUE 分类
intake_session 状态被外部事件污染（伪造 webhook 改写 status）
Clarification 超时窗口被滥用（占用 session 资源）
```

### 6.4 蓝军强制控制

以下控制为 P0：

```text
trusted-control runner 与 untrusted-code runner 分离
不可信代码执行域无 GitHub 写 token、无 Anthropic key、无长期 secret
所有 gate 绑定 SHA / hash
命令必须校验 actor 权限并绑定 plan_id@plan_sha
系统投影事件必须 origin suppression
测试必须在 clean checkout + validated patch 上运行
protected files 变更自动 high 或 critical
外部 PR 默认只读审查
合入前 final evaluator 重新 hydrate GitHub 当前状态
P0 安全回归测试在 MVP 前完成
```

**v3 新增（IM intake 蓝军控制）：**

```text
所有 IM 消息正文按 §6 untrusted content envelope 进入 LLM
IM webhook 签名验证只在 Trusted Control Runner 执行
Bot token / App secret 只在 Trusted Control Runner 持有
IM sender 身份只承认 platform-issued user_id，display_name 不可作为身份证据
sender_github_login 仅在管理员手动审批后填充；未链接前 issue 标记 intake:unverified-sender
Intake 路径不得直接设置权威 label（bug/feature/security 等），权威 label 只能由 MOD-ISSUE 设置
去重幂等键 source_type|external_id|content_hash + 24h 窗口
同一 dedup_key 24h 内只产生 1 个 issue，重复触发返回既有 issue 链接
默认 mode=confirm，高 confidence 路径也需 IM 内一次性确认
Clarification ≤5 轮；24h 不活跃自动 dropped
每条 Intake 决策（explicit/high/low/rejected/dropped）写 audit_records
intake_messages 仅存 PostgreSQL，不写 Artifact Store
仅 intake.decision.* 事件产出 Artifact
```

## 7. 用户流程

### 7.1 普通 issue 自动开发流程

```text
User opens issue
  → Webhook Gateway normalizes event
  → Issue Module triages
  → Analysis Module creates RequirementSpec
  → Planning Module creates ImplementationPlan
  → Maintainer approves plan_id@plan_sha if required
  → Development Module runs Claude Code workers in sandbox
  → Test Module validates clean checkout + patch
  → Commit/PR Module opens PR
  → Review Module posts AI review findings
  → Merge Module evaluates SHA-bound gates
  → final evaluator rehydrates GitHub state
  → PR merged or merge-ready comment posted
  → Issue closed
```

### 7.2 信息不足流程

```text
Issue opened
  → triage detects missing reproduction / expected behavior / environment
  → state = NEEDS_INFO
  → system posts clarification comment
  → user replies
  → issue.comment.created triggers re-triage
  → issue snapshot generation increments if material changed
  → issue becomes READY_FOR_ANALYSIS
```

### 7.3 测试失败修复流程

```text
dev.completed(head_sha)
  → test.requested(head_sha)
  → tests fail
  → failure fingerprint generated
  → debugger diagnoses
  → executor fixes
  → new head_sha produced
  → tests rerun on clean checkout
  → pass or blocked
```

### 7.4 审查修复流程

```text
PR opened(head_sha)
  → code-reviewer + security-reviewer review diff
  → blocking finding found
  → CHANGES_REQUESTED
  → fix.requested
  → executor fixes
  → head_sha changes
  → tests rerun
  → review rerun
```

### 7.5 需求变化流程

```text
issue.edited or material comment added
  → issue_snapshot_sha changes
  → current generation marked STALE
  → old spec / plan / approval invalidated
  → analysis restarts with generation + 1
```

## 8. 总体架构

```text
┌────────────────────────────────────────────────────────────────────┐
│ GitHub                                                             │
│ Issues / Comments / Labels / PR / Reviews / Checks / Merge Queue   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ webhook / api
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ Webhook Gateway                                                     │
│ - signature verification                                            │
│ - event normalization                                               │
│ - delivery deduplication                                            │
│ - origin suppression                                                │
│ - GitHub App installation resolution                                │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ Event Bus + Event Store                                             │
│ issue.* / analysis.* / plan.* / dev.* / test.* / pr.* / review.*    │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ Workflow Orchestrator                                               │
│ state machine / policy / SHA-bound gates / audit / retry / locks    │
└────────────┬─────────────┬────────────┬────────────┬───────────────┘
             ▼             ▼            ▼            ▼
       Issue Module   Analysis Module   Dev Module   Test Module
             ▼             ▼            ▼            ▼
       Plan Module    PR Module         Review Module Merge Module
             └─────────────┬────────────┬────────────┘
                           ▼            ▼
                  Artifact Store   Runner Broker
                                           │
                          ┌────────────────┴────────────────┐
                          ▼                                 ▼
              Trusted Control Runner            Untrusted Code Runner
              - GitHub writes                   - no secrets
              - comments / labels / PR          - no write token
              - final evaluator                 - sandboxed tests
```

部署建议：

```text
API Gateway:        Fastify / Hono / NestJS
Event Bus:          NATS JetStream / Kafka / Redis Streams
State DB:           PostgreSQL
Artifact Store:     S3 / GCS / MinIO
Runner:             GitHub Actions + self-hosted runner 或 Kubernetes Job
GitHub SDK:         Octokit
Claude 执行:        Claude Code Action 或 Claude Agent SDK
Observability:      OpenTelemetry + structured logs + Prometheus
Secret Scanning:    gitleaks / trufflehog / custom redactor
Sandbox:            container + read-only base checkout + write overlay
```

## 9. 状态机

### 9.1 主状态

```text
INTAKE_RECEIVED          (v3 新增，仅 IM 来源 run)
  → INTAKE_CONFIRMING    (v3 新增，clarification 进行中)
  → INTAKE_READY         (v3 新增，建 issue 准备就绪)
NEW
  → TRIAGING
  → NEEDS_INFO
  → READY_FOR_ANALYSIS
  → ANALYZING
  → ANALYSIS_READY
  → PLANNING
  → PLAN_READY
  → WAITING_PLAN_APPROVAL
  → APPROVED_FOR_DEV
  → IMPLEMENTING
  → TESTING
  → FIXING
  → PR_PREPARING
  → PR_READY
  → REVIEWING
  → CHANGES_REQUESTED
  → GATE_EVALUATING
  → MERGE_READY
  → MERGING
  → MERGED
  → CLOSED
```

**v3 INTAKE_* 前置状态说明：** 仅 IM 来源（飞书 / WeCom）的 run 走 INTAKE_* 路径：

```text
INTAKE_RECEIVED   收到 IM webhook，签名验证通过，dedup 检查通过
INTAKE_CONFIRMING 低 confidence 路径进入 IM 内多轮反问（≤5 轮）
INTAKE_READY      显式触发 / 高 confidence / clarification 完成
                  → Intake 发出 intake.issue.create_requested
                  → Trusted Control Runner 创建 GitHub issue（body 内嵌 classification_hint）
                  → 既有 issue.created 事件触发 MOD-ISSUE authoritative triage
                  → workflow run 进入 NEW 状态
```

GitHub 直接创建的 issue **跳过** INTAKE_* 状态，直接进入 `NEW`。Intake 不发出 `issue.triage_requested`（不存在该事件类型）；MOD-ISSUE 始终是 authoritative 分类器。

### 9.2 等待状态

```text
WAITING_USER_INPUT
WAITING_MAINTAINER_APPROVAL
WAITING_SECURITY_APPROVAL
WAITING_BUDGET_APPROVAL
WAITING_CI
WAITING_RATE_LIMIT_RESET
WAITING_MERGE_QUEUE
MANUAL_TAKEOVER
```

### 9.3 异常状态

```text
BLOCKED
FAILED
CANCELLED
DUPLICATE
OUT_OF_SCOPE
STALE
SUPERSEDED
CONFLICTED
SECURITY_HOLD
POLICY_DENIED
```

### 9.4 版本与 generation

每个 workflow run 拥有 `generation`。任何 material input 变化都会生成新 generation。旧 generation 的事件只能写审计，不得推动状态迁移。

Material input 包括：

```text
issue title/body 的语义变化
maintainer 标记的关键 comment
plan revision
branch head_sha 变化
base branch 变化
protected policy 变化
.cgao.yml 变化
```

### 9.5 状态转移 guard

所有状态转移必须校验：

```text
event.generation == workflow.current_generation
event.issue_snapshot_sha == workflow.current_issue_snapshot_sha
event.spec_sha == workflow.current_spec_sha      如果该阶段依赖 spec
event.plan_sha == workflow.current_plan_sha      如果该阶段依赖 plan
event.head_sha == workflow.current_head_sha      如果该阶段依赖代码
event.base_sha == workflow.current_base_sha      如果该阶段依赖 base
```

不满足 guard 的事件进入 `stale_event`，只记录审计，不触发业务动作。

## 10. 事件契约

内部事件采用 CloudEvents 风格。GitHub 原始 payload 存入 Artifact，模块间只传递摘要和引用。

```json
{
  "specversion": "1.0",
  "id": "evt_01JZ9X7N2H2R8P",
  "type": "plan.approved",
  "source": "github:issue_comment",
  "time": "2026-06-29T10:00:00Z",
  "correlation_id": "github:acme/api#issue:123",
  "subject": "acme/api/issues/123",
  "datacontenttype": "application/json",
  "data": {
    "run_id": "wr_01JZ9X7",
    "generation": 2,
    "repo": {
      "owner": "acme",
      "name": "api",
      "default_branch": "main"
    },
    "issue": {
      "number": 123,
      "issue_snapshot_sha": "sha256:..."
    },
    "spec": {
      "id": "spec_01JZ",
      "sha": "sha256:..."
    },
    "plan": {
      "id": "plan_01JZ",
      "sha": "sha256:..."
    },
    "approval": {
      "id": "approval_01JZ",
      "sha": "sha256:...",
      "actor": "alice",
      "permission": "maintain"
    },
    "github": {
      "delivery_id": "...",
      "installation_id": 123456,
      "comment_id": 987654321
    }
  }
}
```

核心 topic：

```text
github.raw
issue.created
issue.updated
issue.material_changed
issue.triaged
issue.needs_info
issue.ready_for_analysis
workflow.command.received
workflow.command.rejected
analysis.requested
analysis.completed
analysis.failed
plan.requested
plan.ready
plan.approved
plan.rejected
dev.requested
dev.task.started
dev.task.completed
dev.completed
dev.failed
test.requested
test.completed
test.failed
fix.requested
pr.requested
pr.opened
pr.updated
review.requested
review.approved
review.changes_requested
security.hold
gate.evaluation_requested
gate.satisfied
gate.failed
merge.requested
merge.ready
merge.completed
merge.failed
reconcile.requested
reconcile.drift_detected
```

**v3 新增 intake.* topic（MOD-INTAKE 使用）：**

```text
intake.webhook.lark                 飞书 webhook 事件，签名验证通过后由 Trusted Control Runner 发出
intake.webhook.wecom                WeCom webhook 事件，同上
intake.decision.explicit            显式触发决策（@bot + 关键词）
intake.decision.llm_high_confidence LLM 高 confidence 直建决策
intake.decision.llm_low_confidence  LLM 低 confidence 进入多轮反问决策
intake.decision.rejected            LLM 判定为非需求/bug 类（噪声）的决策
intake.decision.dropped             clarification 失败、用户放弃或超时决策
intake.issue.create_requested       Intake 请求建 issue（advisory），由 Trusted Control Runner 消费
```

**注意：** v3 **不引入** `issue.triage_requested` 事件类型。Intake 通过 `intake.issue.create_requested` 触发 Trusted Control Runner 创建 GitHub issue；issue 创建由 GitHub 触发既有 `issue.created` 事件，正常流入 MOD-ISSUE 进行 authoritative triage。

## 11. Artifact 模型

Artifact 是流程证据源。所有 Artifact 不可变，使用内容 hash 标识。

Artifact 类型：

```text
issue-snapshot
requirement-spec
implementation-plan
approval-record
agent-prompt
agent-output
handoff
test-log
test-result
review-result
security-result
merge-decision
audit-record
raw-github-payload
```

Artifact classification：

```text
public_summary
internal_log
security_sensitive
audit_restricted
```

写入规则：

1. 写入前执行 secret scanner、PII scanner、high-entropy scanner 和路径过滤。
2. `security_sensitive` 和 `audit_restricted` 不得出现在 GitHub comment 或 PR body 中。
3. GitHub comment 只能引用 artifact id，不暴露内部 URI。
4. Artifact 必须绑定 `run_id`、`generation`、`producer`、`sha256`、`created_at`。
5. 测试日志超过大小限制时截断，并保留 fingerprint 和摘要。

## 12. 模块规格

### 12.0 MOD-INTAKE：Issue Intake 模块（v3 新增）

职责：

1. 接入飞书 / WeCom IM 平台 webhook 事件。
2. 检测显式触发（`@bot` + 关键词词典）。
3. 对未显式触发的消息运行 LLM 软判定（confidence 分层）。
4. 低 confidence 路径在 IM 内发起多轮 Socratic 反问（≤5 轮）。
5. 澄清完成后通过 Trusted Control Runner 创建 GitHub issue。
6. 维护 `intake_sessions / intake_messages / intake_decisions` 状态（仅 PostgreSQL，不写 Artifact）。
7. 按 `dedup_key`（`source_type|external_id|content_hash`）幂等。
8. 把 IM 消息原文以 untrusted content envelope 形式送给 LLM。
9. **Advisory 分类**：Intake 的 LLM 分类只是 `classification_hint`，权威 label 由 MOD-ISSUE 在 `issue.created` 后给出。

输入：飞书 / WeCom 平台 webhook 事件（经 Trusted Control Runner 签名验证后发出 `intake.webhook.*` 事件）。
输出：`intake.issue.create_requested`（委托给 Trusted Control Runner 建 issue）、`intake.decision.*` 事件（写 Artifact）。

**三层触发策略：**

```text
Tier 1（显式触发）：
  @bot + 关键词（"建issue"/"提需求"/"记录"/"bug" 等，词典可配置）
  → 无条件建 issue（仍受 mode=confirm IM 内一次性确认约束）

Tier 2（LLM 高 confidence）：
  未显式 @bot，但 LLM 判定明确属于需求/bug 类（confidence ≥ threshold，默认 0.75）
  → 直接建 issue（mode=auto）或在 IM 内一次性确认（mode=confirm）

Tier 3（LLM 低 confidence）：
  LLM 判定可能属于需求类但置信度不足
  → 在 IM 内发起多轮 Socratic 反问（≤5 轮）
  → 澄清到能建 issue 或显式放弃 / 24h 不活跃超时
```

**事件流（advisory，不 bypass MOD-ISSUE）：**

```text
[intake.webhook.lark|wecom]
   ↓
MOD-INTAKE
   ├─ Tier 1 显式触发       → intake.decision.explicit
   ├─ Tier 2 LLM 高 conf.   → intake.decision.llm_high_confidence
   └─ Tier 3 LLM 低 conf.   → intake.decision.llm_low_confidence
                              ↓
                          IM 内多轮反问（≤5 轮）
                              ↓
                          intake.decision.explicit (澄清完成)
                          或 intake.decision.dropped (失败/超时/放弃)
   ↓
intake.issue.create_requested（事件 → Trusted Control Runner）
   ↓
Trusted Control Runner 调用 GitHub API 建 issue
  - 仅设最小初始 label：cgao:new、intake:im
  - body 内嵌 cgao metadata 与 classification_hint（advisory）
  - 不设 bug/feature/security 等权威 label
   ↓
issue.created（GitHub 触发既有事件）
   ↓
MOD-ISSUE（authoritative triage）
  - 读取 body 中 classification_hint
  - 重新 hydrate repo state（labels、milestones、sibling issues）
  - accept 或 override hint，设置权威 label
  - 写 audit_records（accept_hint / override_hint + reason）
   ↓
进入既有 v2 pipeline（READY_FOR_ANALYSIS → ...）
```

**配置（`.cgao.yml` 的 `intake` 块，详见 §18）：**

```text
mode: auto | confirm | off（默认 confirm）
sources.lark.enabled / sources.wecom.enabled
sources.lark.triggers.explicit_keywords[] / sources.lark.triggers.at_bot_only
sources.lark.llm.confidence_threshold（默认 0.75）
sources.lark.llm.max_clarify_rounds（默认 5）
dedup.window_minutes（默认 1440，即 24h）
security.redact_before_llm（默认 true）
security.untrusted_envelope（默认 true）
```

**Artifact 政策（与 §4.9 一致）：**

```text
intake_messages：仅 PostgreSQL，不写 Artifact Store
intake_sessions / intake_decisions：仅 PostgreSQL
intake.decision.* 事件：写 Artifact（最终决策记录）
建 issue 动作：不直接调用 GitHub API，只发 intake.issue.create_requested
```

验收：

```text
显式 @bot + 关键词必建 issue（mode=auto）或在 IM 内确认后建（mode=confirm）
LLM 高 confidence（≥ threshold）建 issue，precision ≥ 0.85
LLM 低 confidence 进入 IM 内多轮反问，最多 5 轮
同一 dedup_key 24h 内只产生 1 个 issue
IM 消息原文不直接进入系统 prompt，必须经 untrusted envelope
prompt injection 回归测试通过
建 issue 动作只能通过 Trusted Control Runner 完成
intake_messages 不出现在 Artifact Store
权威 label（bug/feature/security）由 MOD-ISSUE 设置，Intake 不设置
每条 Intake 决策写 audit_records
```

### 12.1 MOD-WEBHOOK：Webhook Gateway

职责：

1. 验证 GitHub webhook 签名。
2. 记录 `X-GitHub-Delivery` 并去重。
3. 标准化事件。
4. 判断事件是否来自 CGAO 自己的投影写操作。
5. 将原始 payload 写入 Artifact。
6. 快速 ACK，并将业务处理交给 Event Bus。

输入：GitHub webhook。  
输出：`github.raw`、`issue.*`、`pr.*`、`review.*`、`workflow.*`。

验收：

```text
重复 delivery 不产生重复业务事件
系统自己创建/编辑的 comment 不触发业务循环
系统自己同步的 label 不直接驱动状态迁移
无效签名拒绝
payload 超限或 artifact 写失败时阻断后续业务处理
```

### 12.2 MOD-RECONCILER：状态校准模块

职责：

1. 周期性扫描 active workflow runs。
2. 重新读取 GitHub issue、PR、labels、reviews、checks、head_sha、base_sha。
3. 对比 Orchestrator DB 状态。
4. 发现 drift 后生成 `reconcile.drift_detected`。
5. 修正 GitHub 投影，或将 run 置为 `STALE` / `MANUAL_TAKEOVER`。

验收：

```text
服务停机期间的 issue/PR/check/review 变化可恢复
漏投 webhook 不导致永久状态漂移
PR 被人工 merge/close 后系统可正确归档或终止
GitHub label 被人工改错后系统能恢复投影
```

### 12.3 MOD-ISSUE：Issue 管理模块

职责：

1. 接收 issue、comment、label、assigned、closed、reopened 事件。
2. 判断 issue 类型：bug、feature、docs、question、security、chore。
3. 判断信息是否足够。
4. 维护 GitHub label 和 status comment。
5. 识别控制命令。
6. 输出标准化 issue 事件。

命令列表：

```text
/approve-plan <plan_id>@<plan_sha>
/revise-plan <reason>
/retry
/cancel
/block <reason>
/resume
/merge-ready
/manual-only
/trust-run
```

命令规则：

```text
只接受 issue_comment.created，不接受 edited command
命令 actor 必须实时查询 GitHub 权限
/approve-plan 必须绑定 plan_id@plan_sha
命令必须写 command_authorizations 审计记录
伪造 cgao marker 无效
系统 bot 自己创建的 comment 不解析为命令
```

验收：

```text
重复 webhook 不重复评论
同一 workflow run 只有一条 active status comment
信息不足的问题必须包含明确补充项
关闭的 issue 不进入开发流程
未授权 actor 的命令被拒绝并记录审计
旧 plan_sha 的 approve 命令无效
```

### 12.4 MOD-ANALYSIS：需求分析模块

职责：

1. 从 issue title、body、comments、labels 中提取需求。
2. 生成 `RequirementSpec`。
3. 提炼目标、非目标、验收标准、影响面、风险和开放问题。
4. 判断自动化资格。
5. 将所有用户内容包裹在不可信内容区，防止 prompt injection。

`RequirementSpec` schema：

```json
{
  "id": "spec_01J...",
  "run_id": "wr_01J...",
  "generation": 2,
  "issue_number": 123,
  "issue_snapshot_sha": "sha256:...",
  "sha": "sha256:...",
  "summary": "Add OIDC SSO login",
  "problem_statement": "...",
  "goals": ["..."],
  "non_goals": ["..."],
  "acceptance_criteria": [
    {
      "id": "AC1",
      "text": "...",
      "verification": "unit|integration|e2e|review|manual"
    }
  ],
  "affected_areas": ["auth", "frontend"],
  "risks": [
    {
      "level": "low|medium|high|critical",
      "category": "security|data|compatibility|performance|infra",
      "description": "..."
    }
  ],
  "open_questions": [],
  "automation_eligibility": {
    "eligible": true,
    "requires_plan_approval": true,
    "requires_human_merge_approval": true
  }
}
```

验收：

```text
每条需求必须能映射到至少一条验收标准或开放问题
open_questions 非空时状态回到 NEEDS_INFO
LLM 只能升高风险，不得降低 deterministic risk
RequirementSpec 必须绑定 issue_snapshot_sha
```

### 12.5 MOD-PLAN：规划模块

职责：

1. 根据 `RequirementSpec` 生成 `ImplementationPlan`。
2. 拆分任务，标注依赖、风险、路径范围、推荐 agent 和模型档位。
3. 定义测试 gate 和合入策略。
4. 将计划摘要写入 issue comment。
5. 生成可审批的 `plan_id@plan_sha`。

`ImplementationPlan` schema：

```json
{
  "id": "plan_01J...",
  "run_id": "wr_01J...",
  "generation": 2,
  "spec_id": "spec_01J...",
  "spec_sha": "sha256:...",
  "sha": "sha256:...",
  "base_branch": "main",
  "base_sha": "abc123",
  "work_branch": "cgao/issue-123-short-slug",
  "strategy": "single_branch|parallel_worktree",
  "risk_level": "low|medium|high|critical",
  "tasks": [
    {
      "id": "task-auth-config",
      "title": "Add auth config schema",
      "agent": "executor",
      "model_tier": "haiku|sonnet|opus",
      "files_hint": ["src/auth/**"],
      "allowed_paths": ["src/auth/**", "tests/auth/**"],
      "forbidden_paths": [".github/**", ".cgao/**", ".claude/**", "infra/prod/**"],
      "depends_on": [],
      "acceptance_criteria": ["AC1"]
    }
  ],
  "quality_gates": ["lint", "typecheck", "unit"],
  "merge_policy": {
    "auto_merge": false,
    "required_human_reviews": 1,
    "required_ai_reviews": ["code-reviewer", "security-reviewer"]
  }
}
```

验收：

```text
所有 acceptance criteria 至少映射到一个 task
高风险路径必须加入 gated policy
计划必须可审阅、可批准、可驳回
计划审批必须绑定 plan_id@plan_sha
```

### 12.6 MOD-DEV：开发模块

职责：

1. 为 issue 创建主工作分支。
2. 为并行 task 创建独立 workspace、worktree 或临时分支。
3. 调用 Claude Code runner 执行开发任务。
4. 收集 agent 输出、变更文件、局部测试结果。
5. 输出 validated patch，不把脏 workspace 直接交给测试域。

Worker 输出 schema：

```json
{
  "agent_run_id": "ar_01J...",
  "task_id": "task-auth-config",
  "status": "completed|failed|blocked",
  "base_sha": "abc123",
  "head_sha": "def456",
  "patch_sha": "sha256:...",
  "changed_files": ["src/auth/config.ts"],
  "summary": "...",
  "tests_run": [
    {
      "command": "npm test -- tests/auth/config.test.ts",
      "exit_code": 0,
      "log_ref": "artifact://test-log"
    }
  ],
  "risks": ["..."],
  "handoff_ref": "artifact://handoff"
}
```

验收：

```text
Worker 不得修改 forbidden path
Worker 不得直接合入
Worker 不得创建最终 PR review approval
测试前必须从 clean checkout 应用 validated patch
并行 workspace 脏状态必须保留到 artifact，不得无审计强删
```

### 12.7 MOD-TEST：测试模块

职责：

1. 运行 format、lint、typecheck、unit、integration、e2e、安全扫描等 gate。
2. 解析失败日志，生成 failure fingerprint。
3. 调用 debugger 诊断。
4. 调用 executor 修复。
5. 控制最多 5 次 QA cycle，同一失败最多 3 次。
6. 所有测试在 no-secret execution mode 中运行。

QA 状态 schema：

```json
{
  "run_id": "wr_01J...",
  "generation": 2,
  "cycle": 2,
  "max_cycles": 5,
  "head_sha": "def456",
  "base_sha": "abc123",
  "status": "passed|failed|blocked",
  "failures": [
    {
      "fingerprint": "jest:auth/config.test.ts:expected-provider",
      "seen_count": 2,
      "log_ref": "artifact://log"
    }
  ],
  "gate_results": [
    {
      "name": "lint",
      "status": "passed",
      "evidence_ref": "artifact://lint-log"
    }
  ]
}
```

验收：

```text
最多 5 个修复 cycle
同一 fingerprint 3 次后 BLOCKED
测试 job 无 GitHub 写 token、无 Anthropic key、无长期 secret
package script exfiltration 测试通过
测试结果绑定 head_sha 和 base_sha
```

### 12.8 MOD-PR：Commit 与 PR 模块

职责：

1. 汇总 task patch。
2. 验证 forbidden path、protected file、dependency manifest 变更。
3. 生成原子 commit。
4. 创建或更新 PR。
5. 维护 PR body traceability。
6. 写入 PR 与 workflow run 的唯一绑定。

PR body 只做展示，不作为 gate 证据。验收证据来自 `gate_results` 和 `verification_results`。

验收：

```text
重复事件不会创建重复 PR
PR body 包含 run_id、issue、spec_id、plan_id、head_sha
受保护文件变更自动提升风险等级
新增依赖必须触发 dependency policy
```

### 12.9 MOD-REVIEW：审查模块

职责：

1. 执行 code-reviewer、security-reviewer、verifier。
2. 生成结构化 `ReviewFinding`。
3. 将 blocking finding 映射到 GitHub review comment 或 PR comment。
4. 管理 finding lifecycle。
5. 将审查结果绑定 head_sha 和 diff_sha。

`ReviewFinding` schema：

```json
{
  "id": "finding_01J...",
  "finding_hash": "sha256:...",
  "run_id": "wr_01J...",
  "head_sha": "def456",
  "severity": "minor|major|critical",
  "category": "correctness|security|compatibility|test|maintainability",
  "file": "src/auth/callback.ts",
  "line": 87,
  "title": "State parameter is not bound to session",
  "description": "...",
  "recommendation": "...",
  "blocking": true,
  "status": "open|fixed|dismissed"
}
```

Finding 关闭规则：

```text
blocking finding 不能因为新 review 漏报而自动关闭
fixed 必须由同类 reviewer 在新 head_sha 上明确确认
dismissed 必须由授权 maintainer 给出 reason
```

验收：

```text
实现 agent 不能最终 approve 自己的变更
review result 绑定 head_sha
blocking finding 生命周期可追踪
安全审查与代码审查分离
```

### 12.10 MOD-MERGE：合入模块

职责：

1. 汇总 CI、AI review、人类 review、risk policy、branch protection 和 merge queue 状态。
2. 执行 SHA-bound final evaluation。
3. 产生 `merge-decision` Artifact。
4. 合入或发布 merge-ready comment。
5. 合入后关闭 issue、清理 label、归档审计。

合入前 final evaluator 必须检查：

```text
PR open
current_head_sha == tested_head_sha
current_head_sha == reviewed_head_sha
current_head_sha == human_approved_head_sha 如果策略要求人工 review
base_sha 与 gate 记录一致，或当前 PR 已进入 merge queue 并通过 merge_group checks
required checks 当前为 green
required reviews 当前满足
无 unresolved blocking finding
无 cgao:block / manual-only
issue 仍有效
merge-manager token 不具备 bypass branch protection 权限
```

验收：

```text
PR synchronize 后旧测试、旧 review、旧 approval 失效
base branch 变化后重新测试或进入 merge queue
合入前重新读取 GitHub 当前状态
merge decision 有 policy decision record
```

### 12.11 MOD-POLICY：策略模块

职责：

1. 执行风险分类。
2. 管理角色权限、路径权限、命令权限、合入策略。
3. 对 protected files、依赖变更、CI/CD 变更进行强制升风险。
4. 控制成本、速率和外部 actor 策略。

确定性风险规则优先级高于 LLM。LLM 可以升高风险，不能降低确定性风险。

Protected files：

```text
.cgao.yml
.cgao/**
.claude/**
.github/**
package.json
package-lock.json
pnpm-lock.yaml
yarn.lock
bun.lockb
requirements.txt
poetry.lock
Cargo.toml
Cargo.lock
go.mod
go.sum
Dockerfile
docker-compose.yml
Makefile
scripts/**
infra/**
prod/**
secrets/**
```

## 13. Runner 权限模型

### 13.1 权限域

| Runner 域 | 可执行内容 | 凭据 | GitHub 写权限 | 用途 |
|---|---|---|---:|---|
| Trusted Control Runner | 不 checkout 不可信代码 | GitHub App token、artifact write token | Yes | comment、label、PR、merge decision |
| Untrusted Code Runner | checkout PR/head，运行测试 | 无长期 secret，无 Anthropic key | No | test、lint、typecheck、build |
| Claude Dev Runner | 受控 workspace 中编辑 patch | 短期受限凭据 | 受 broker 控制 | 代码实现 |
| Review Runner | diff read-only | 只读 token | PR comment 经 broker | code/security review |

### 13.2 Agent 角色与工具

| Role | Tools | Write allowed | Merge allowed | Notes |
|---|---|---:|---:|---|
| analyst | Read/Grep/Glob | No | No | 用户内容不可信 |
| planner | Read/Grep/Glob | No | No | 输出 plan，不改代码 |
| architect | Read/Grep/Glob/Bash read-only | No | No | 可读 repo 结构 |
| executor | Read/Edit/Write/Bash limited | Yes | No | 只输出 patch |
| debugger | Read/Edit/Write/Bash limited | Yes | No | 只修复测试失败 |
| test-engineer | Read/Edit/Write/Bash limited | Yes | No | 无 secret test |
| verifier | Read/Grep/Glob/Bash test | No | No | 验收证据 |
| code-reviewer | Read/Grep/Glob/Bash read-only | No | No | 独立审查 |
| security-reviewer | Read/Grep/Glob/Bash read-only | No | No | 独立安全审查 |
| git-master | Git operations through broker | Yes | No | commit/PR |
| merge-manager | GitHub merge API through broker | No | Yes | final evaluator 后执行 |

### 13.3 Filesystem sandbox

开发和测试必须采用：

```text
read-only base checkout
write overlay limited to allowed paths
forbidden path runtime write deny
agent 结束后生成 patch
clean checkout 重新 apply patch
validated patch 才能进入测试和 PR 模块
```

事后 diff 检查只能作为最后一道线，不能替代运行期 filesystem sandbox。

## 14. GitHub 协作面

### 14.1 Labels

GitHub label 只作为投影。人工修改 `cgao:*` label 触发 reconciliation，不直接改变内部状态。

```text
cgao:new
cgao:triaging
cgao:needs-info
cgao:analysis
cgao:planning
cgao:approved
cgao:implementing
cgao:testing
cgao:reviewing
cgao:changes-requested
cgao:merge-ready
cgao:blocked
cgao:failed
cgao:manual-only
```

**v3 新增 intake:* label（仅由 Intake 路径设置，区分来源与验证状态）：**

```text
intake:im                  Issue 由 IM intake 路径创建（飞书 / WeCom）
intake:unverified-sender   sender_github_login 未链接，需要人工 review
```

### 14.2 Status comments

系统评论必须包含 marker，但 marker 只用于定位和更新评论：

```md
<!-- cgao:run_id=wr_01JZ9X7 state=PLAN_READY comment_role=status -->
```

系统必须在 DB 中保存 `comment_id` 和 author 校验信息。任何用户伪造 marker 的 comment 都不能作为状态来源。

### 14.3 Commands

命令授权表：

| Command | Required permission | Extra binding |
|---|---|---|
| `/approve-plan <plan_id>@<plan_sha>` | maintain/admin | plan hash 必须匹配当前 generation |
| `/revise-plan <reason>` | maintain/admin | 当前 state 必须在 PLAN_READY 后 |
| `/retry` | triage/maintain/admin | 受 retry policy 限制 |
| `/cancel` | maintain/admin | 写 audit reason |
| `/block <reason>` | maintain/admin | 无条件阻断 |
| `/resume` | maintain/admin | 需重新 evaluate policy |
| `/merge-ready` | maintain/admin | 不能绕过 final evaluator |
| `/manual-only` | maintain/admin | 禁止自动合入 |
| `/trust-run` | maintain/admin | 仅用于外部 PR 或高风险 runner |

**v3 IM 命令源说明：** IM 消息（飞书 / WeCom）**不**作为命令源。所有 CGAO 命令（`/approve-plan`、`/cancel`、`/merge-ready` 等）只接受 `issue_comment.created` 事件（GitHub issue 上的评论）。IM 内的"放弃"/"cancel"等指令仅作用于 Intake 会话本身（如放弃当前 clarification），不影响后续 workflow run 的状态机。

## 15. 数据库模型

```sql
create table workflow_runs (
  id text primary key,
  repo_owner text not null,
  repo_name text not null,
  issue_number integer,
  pr_number integer,
  state text not null,
  risk_level text not null default 'unknown',
  generation integer not null default 1,
  current_issue_snapshot_sha text,
  current_spec_id text,
  current_spec_sha text,
  current_plan_id text,
  current_plan_sha text,
  current_approval_id text,
  current_approval_sha text,
  current_head_sha text,
  current_base_sha text,
  current_module text,
  current_attempt integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  version integer not null default 0
);

create table github_deliveries (
  delivery_id text primary key,
  event_name text not null,
  repo_owner text,
  repo_name text,
  received_at timestamptz not null default now(),
  payload_sha256 text not null,
  processed boolean not null default false
);

create table workflow_events (
  id text primary key,
  run_id text references workflow_runs(id),
  type text not null,
  source text not null,
  correlation_id text not null,
  generation integer,
  issue_snapshot_sha text,
  spec_sha text,
  plan_sha text,
  head_sha text,
  base_sha text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'pending',
  error text
);

create table github_mutations (
  id text primary key,
  run_id text references workflow_runs(id),
  resource_type text not null,
  resource_id text,
  mutation_kind text not null,
  expected_echo_event text,
  github_actor text,
  created_at timestamptz not null default now(),
  observed_at timestamptz
);

create table command_authorizations (
  id text primary key,
  run_id text references workflow_runs(id),
  command text not null,
  actor_login text not null,
  actor_permission text not null,
  source_comment_id bigint not null,
  target_plan_id text,
  target_plan_sha text,
  authorized boolean not null,
  reason jsonb not null,
  created_at timestamptz not null default now()
);

create table agent_runs (
  id text primary key,
  run_id text references workflow_runs(id),
  task_id text,
  role text not null,
  model text,
  status text not null,
  workspace_path text,
  input_artifact_id text,
  output_artifact_id text,
  head_sha text,
  base_sha text,
  patch_sha text,
  started_at timestamptz,
  finished_at timestamptz,
  token_input integer,
  token_output integer,
  cost_usd numeric
);

create table artifacts (
  id text primary key,
  run_id text references workflow_runs(id),
  generation integer not null,
  kind text not null,
  classification text not null,
  uri text not null,
  sha256 text not null,
  size_bytes bigint,
  producer text,
  redaction_status text not null default 'pending',
  encryption_key_id text,
  access_policy text not null default 'internal',
  retention_until timestamptz,
  created_at timestamptz not null default now()
);

create table gate_results (
  id text primary key,
  run_id text references workflow_runs(id),
  gate_name text not null,
  status text not null,
  head_sha text not null,
  base_sha text,
  evidence_artifact_id text,
  created_at timestamptz not null default now()
);

create table review_findings (
  id text primary key,
  finding_hash text not null,
  run_id text references workflow_runs(id),
  pr_number integer,
  head_sha text not null,
  severity text not null,
  category text not null,
  file_path text,
  line_number integer,
  title text not null,
  description text not null,
  recommendation text,
  blocking boolean not null default false,
  status text not null default 'open',
  closed_by text,
  close_reason text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table policy_decisions (
  id text primary key,
  run_id text references workflow_runs(id),
  policy_version text not null,
  decision text not null,
  reason jsonb not null,
  head_sha text,
  base_sha text,
  created_at timestamptz not null default now()
);

create table audit_records (
  id text primary key,
  run_id text references workflow_runs(id),
  previous_hash text,
  record_hash text not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
```

**v3 新增 Intake 相关表：**

```sql
create table intake_sessions (
  id text primary key,
  source_type text not null,         -- 'lark' | 'wecom'
  external_id text not null,         -- IM 平台消息/线程 id
  content_hash text not null,        -- sha256(normalized_content)
  channel_id text,
  thread_id text,
  sender_im_user_id text,
  sender_github_login text,          -- 可空，链接后才有
  status text not null,              -- 'pending' | 'confirming' | 'created' | 'dropped'
  created_issue_number integer,
  workflow_run_id text,
  dedup_key text not null,           -- source_type|external_id|content_hash
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dedup_key)
);

create table intake_messages (
  id text primary key,
  session_id text references intake_sessions(id),
  role text not null,                -- 'user' | 'bot' | 'system'
  content text not null,
  redacted_content_artifact_id text,
  received_at timestamptz not null default now()
);

create table intake_decisions (
  id text primary key,
  session_id text references intake_sessions(id),
  decision text not null,            -- 'explicit_trigger' | 'llm_high_confidence' | 'llm_low_confidence' | 'rejected' | 'dropped'
  confidence numeric,
  reason jsonb not null,
  created_at timestamptz not null default now()
);

create index idx_intake_sessions_status on intake_sessions(status);
create index idx_intake_sessions_source_external on intake_sessions(source_type, external_id);
create index idx_intake_sessions_created_at on intake_sessions(created_at);
create index idx_intake_decisions_session on intake_decisions(session_id);
```

**注意：** `intake_messages` 仅存 PostgreSQL，不写 Artifact Store（与 §12.0 Artifact 政策一致）。只有 `intake.decision.*` 事件产出 Artifact。

## 16. API 规格

### 16.1 接收事件

```http
POST /events
Content-Type: application/cloudevents+json
```

响应：

```json
{
  "accepted": true,
  "event_id": "evt_01J...",
  "run_id": "wr_01J..."
}
```

### 16.2 创建 agent run

```http
POST /agent-runs
Content-Type: application/json
```

请求：

```json
{
  "run_id": "wr_01J...",
  "generation": 2,
  "role": "executor",
  "task_id": "task-auth-config",
  "model": "sonnet",
  "repo": "acme/api",
  "checkout_ref": "cgao/issue-123-short-slug",
  "base_sha": "abc123",
  "plan_sha": "sha256:...",
  "prompt_artifact": "artifact://agent-prompt",
  "allowed_tools": ["Read", "Edit", "Write", "Bash"],
  "allowed_paths": ["src/auth/**", "tests/auth/**"],
  "forbidden_paths": [".github/**", ".cgao/**", ".claude/**"],
  "timeout_seconds": 1800,
  "sandbox_profile": "no-secret-dev"
}
```

### 16.3 Workflow 控制

```http
GET /workflow-runs/{run_id}
POST /workflow-runs/{run_id}/retry
POST /workflow-runs/{run_id}/cancel
POST /workflow-runs/{run_id}/resume
POST /workflow-runs/{run_id}/override-policy
POST /workflow-runs/{run_id}/reconcile
```

### 16.4 Policy evaluation

```http
POST /policy/evaluate
Content-Type: application/json
```

请求：

```json
{
  "run_id": "wr_01J...",
  "stage": "merge_final_evaluation",
  "head_sha": "def456",
  "base_sha": "abc123",
  "changed_files": ["src/auth/callback.ts"],
  "gate_results": ["lint", "unit", "security-review"],
  "actor": "cgao-app"
}
```

## 17. GitHub Actions 示例

### 17.1 Event Bridge

事件桥只转发事件，不执行业务逻辑。

```yaml
name: CGAO Event Bridge

on:
  issues:
    types: [opened, edited, labeled, unlabeled, assigned, reopened, closed]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, closed]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  workflow_run:
    types: [completed]
  merge_group:
    types: [checks_requested]

permissions:
  contents: read
  issues: read
  pull-requests: read
  checks: read
  actions: read

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Send event to CGAO
        run: |
          curl -sS -X POST "$CGAO_WEBHOOK_URL" \
            -H "Authorization: Bearer $CGAO_TOKEN" \
            -H "X-GitHub-Event: $GITHUB_EVENT_NAME" \
            -H "Content-Type: application/json" \
            --data-binary @"$GITHUB_EVENT_PATH"
        env:
          CGAO_WEBHOOK_URL: ${{ secrets.CGAO_WEBHOOK_URL }}
          CGAO_TOKEN: ${{ secrets.CGAO_TOKEN }}
```

### 17.2 Untrusted Test Runner

```yaml
name: CGAO Untrusted Test Runner

on:
  repository_dispatch:
    types: [cgao_test_untrusted]

permissions:
  contents: read
  actions: read
  checks: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.client_payload.head_sha }}
          persist-credentials: false
      - name: Run no-secret tests
        run: |
          npm ci --ignore-scripts
          npm run lint
          npm run typecheck
          npm test
```

生产实现中，`npm ci --ignore-scripts` 与实际项目需求可能冲突。若项目需要 install scripts，必须在隔离容器、无 secret、无外网或受控外网策略下运行。

### 17.3 Trusted Control Runner

```yaml
name: CGAO Trusted Control Runner

on:
  repository_dispatch:
    types: [cgao_write_github, cgao_merge_evaluate]

permissions:
  contents: write
  issues: write
  pull-requests: write
  checks: read
  actions: read

jobs:
  control:
    runs-on: ubuntu-latest
    steps:
      - name: Execute trusted control action
        run: |
          curl -sS -X POST "$CGAO_CONTROL_URL" \
            -H "Authorization: Bearer $CGAO_CONTROL_TOKEN" \
            -H "Content-Type: application/json" \
            --data '${{ toJson(github.event.client_payload) }}'
        env:
          CGAO_CONTROL_URL: ${{ secrets.CGAO_CONTROL_URL }}
          CGAO_CONTROL_TOKEN: ${{ secrets.CGAO_CONTROL_TOKEN }}
```

### 17.4 Intake Lark Webhook Receiver（v3 新增）

飞书 webhook 接收器。**签名验证必须在此 runner 内执行**；Bot token / App secret 不得离开 Trusted Control Runner。

```yaml
name: CGAO Intake Lark Webhook Receiver

on:
  repository_dispatch:
    types: [intake_lark]

permissions:
  contents: read
  issues: write
  pull-requests: read

jobs:
  intake_lark_verify:
    runs-on: cgao-trusted-runner
    steps:
      - name: Verify Lark signature and emit normalized event
        run: |
          # 1. 校验 X-Lark-Signature against $LARK_APP_SECRET
          # 2. 无效签名 → HTTP 401，不发事件
          # 3. 有效签名 → 归一化为 CloudEvents 风格 envelope
          curl -sS -X POST "$CGAO_INTAKE_WEBHOOK_URL" \
            -H "Authorization: Bearer $CGAO_CONTROL_TOKEN" \
            -H "X-CGAO-Source: lark" \
            -H "Content-Type: application/json" \
            --data-binary @"$GITHUB_EVENT_PATH"
        env:
          LARK_APP_SECRET: ${{ secrets.LARK_APP_SECRET }}
          CGAO_INTAKE_WEBHOOK_URL: ${{ secrets.CGAO_INTAKE_WEBHOOK_URL }}
          CGAO_CONTROL_TOKEN: ${{ secrets.CGAO_CONTROL_TOKEN }}
```

### 17.5 Intake WeCom Webhook Receiver（v3 新增）

企业微信 webhook 接收器，与 §17.4 镜像。`msg_signature` 验证、`WECOM_CORP_ID`、`WECOM_AGENT_SECRET` 仅在此 runner 内可用。

```yaml
name: CGAO Intake WeCom Webhook Receiver

on:
  repository_dispatch:
    types: [intake_wecom]

permissions:
  contents: read
  issues: write
  pull-requests: read

jobs:
  intake_wecom_verify:
    runs-on: cgao-trusted-runner
    steps:
      - name: Verify WeCom msg_signature and emit normalized event
        run: |
          # 1. 校验 msg_signature against $WECOM_TOKEN / $WECOM_ENCODING_AES_KEY
          # 2. 无效签名 → HTTP 401，不发事件
          # 3. 有效签名 → 归一化为 CloudEvents 风格 envelope
          curl -sS -X POST "$CGAO_INTAKE_WEBHOOK_URL" \
            -H "Authorization: Bearer $CGAO_CONTROL_TOKEN" \
            -H "X-CGAO-Source: wecom" \
            -H "Content-Type: application/json" \
            --data-binary @"$GITHUB_EVENT_PATH"
        env:
          WECOM_CORP_ID: ${{ secrets.WECOM_CORP_ID }}
          WECOM_AGENT_SECRET: ${{ secrets.WECOM_AGENT_SECRET }}
          WECOM_TOKEN: ${{ secrets.WECOM_TOKEN }}
          WECOM_ENCODING_AES_KEY: ${{ secrets.WECOM_ENCODING_AES_KEY }}
          CGAO_INTAKE_WEBHOOK_URL: ${{ secrets.CGAO_INTAKE_WEBHOOK_URL }}
          CGAO_CONTROL_TOKEN: ${{ secrets.CGAO_CONTROL_TOKEN }}
```

**安全硬约束：** §17.4 / §17.5 的签名验证必须在 Trusted Control Runner 内执行；MOD-INTAKE 业务逻辑（dedup / classify / clarify / emit `intake.issue.create_requested`）订阅 `intake.webhook.*` 事件，**零** 平台凭据。建 issue 动作由 `cgao-intake-issue-create` job 在 Trusted Control Runner 中消费 `intake.issue.create_requested` 完成。

## 18. 配置文件

仓库根目录配置：

```yaml
# .cgao.yml
version: 2

automation:
  enabled: true
  default_mode: assisted
  allow_auto_merge: false

security:
  treat_issue_text_as_untrusted: true
  require_sha_bound_gates: true
  require_clean_checkout_tests: true
  no_secret_test_execution: true
  external_pr_default_mode: read_only
  allow_pull_request_target_checkout: false

risk:
  high_risk_paths:
    - "src/auth/**"
    - "src/payments/**"
    - "infra/**"
    - ".github/**"
    - ".cgao/**"
    - ".claude/**"
    - "scripts/**"
  critical_paths:
    - "prod/**"
    - "secrets/**"
  dependency_files:
    - "package.json"
    - "package-lock.json"
    - "pnpm-lock.yaml"
    - "yarn.lock"
    - "requirements.txt"
    - "poetry.lock"
    - "Cargo.toml"
    - "Cargo.lock"
    - "go.mod"
    - "go.sum"

approval:
  require_plan_approval_for:
    - medium
    - high
    - critical
  require_human_review_for:
    - medium
    - high
    - critical

quality_gates:
  fast:
    - "npm run lint"
    - "npm run typecheck"
  standard:
    - "npm test"
  high_risk:
    - "npm run test:integration"
    - "npm audit --audit-level=high"

claude:
  default_model:
    analyst: "opus"
    planner: "opus"
    executor: "sonnet"
    debugger: "sonnet"
    test_engineer: "sonnet"
    code_reviewer: "opus"
    security_reviewer: "sonnet"

limits:
  max_test_fix_cycles: 5
  max_same_failure_count: 3
  max_agent_turns: 8
  max_changed_files_auto_merge: 10
  max_agent_runs_per_repo_per_hour: 20
  max_external_actor_runs_per_day: 2

intake:
  enabled: true
  mode: confirm                      # auto | confirm | off（默认 confirm）
  sources:
    lark:
      enabled: true
      app_id: "${LARK_APP_ID}"
      triggers:
        explicit_keywords: ["建issue", "提需求", "记录", "bug"]
        at_bot_only: true
      llm:
        confidence_threshold: 0.75
        max_clarify_rounds: 5
        inactivity_timeout_hours: 24
        classifier_model: "sonnet"   # haiku 仅用于 keyword-only 显式触发 fast path
    wecom:
      enabled: true
      corp_id: "${WECOM_CORP_ID}"
      triggers:
        explicit_keywords: ["建issue", "提需求", "记录", "bug"]
        at_bot_only: true
      llm:
        confidence_threshold: 0.75
        max_clarify_rounds: 5
        inactivity_timeout_hours: 24
        classifier_model: "sonnet"
  dedup:
    window_minutes: 1440              # 24h
    key: ["source_type", "external_id", "content_hash"]
  rate_limit:
    max_llm_calls_per_repo_per_hour: 30
  security:
    redact_before_llm: true
    untrusted_envelope: true
    reject_external_links: false      # phase 2 可收紧
```

## 19. 审计与可观测性

每个 workflow run 至少记录：

```text
actor
trigger event
state transition
policy decision
agent role
model
prompt artifact
output artifact
changed files
test logs
review findings
merge decision
commit sha
merge sha
hash chain
```

核心指标：

```text
issue_to_plan_seconds
plan_to_pr_seconds
pr_to_merge_seconds
agent_run_success_rate
test_fix_cycle_count
same_failure_block_count
auto_merge_rate
human_intervention_rate
review_findings_by_category
cost_per_workflow_run
tokens_per_agent_role
stale_event_count
reconciliation_drift_count
policy_denied_count
```

审计记录必须形成 hash chain：

```text
audit_record_hash = hash(previous_hash + canonical_json(current_record))
```

生产环境应定期将 audit checkpoint 写入不可变存储。

## 20. 异常处理

| 场景 | 处理 |
|---|---|
| 重复 webhook | 通过 delivery id 去重，返回 200 |
| 自激活 comment / label | origin suppression，标记 observed，不进入业务流 |
| Claude runner 超时 | agent_run=timeout，低风险自动重试一次，高风险进入 BLOCKED |
| 分支冲突 | git-master 尝试 rebase；失败进入 CONFLICTED |
| 测试反复失败 | 同 fingerprint 3 次或 cycle 5 次后 BLOCKED |
| 需求变化 | 当前 generation 标记 STALE，重新 analysis |
| PR synchronize | 旧测试、旧 review、旧 approval 失效 |
| base branch 前进 | 重新测试或进入 merge queue |
| 外部贡献者 PR | 默认只读审查，不使用高权限 token 执行不可信代码 |
| workflow artifact 来源不可信 | 不作为控制输入，仅供只读摘要 |
| GitHub API 限流 | 退避重试，超过阈值进入 WAITING_RATE_LIMIT_RESET |
| Artifact 写失败 | 阻断流程，不允许无审计继续执行 |
| Artifact 含 secret | redaction 或 classification=security_sensitive，不写 GitHub comment |
| 成本超限 | WAITING_BUDGET_APPROVAL |

## 21. 验收标准

系统级验收标准：

1. 创建一个有效 bug issue 后，系统能自动生成 triage comment、RequirementSpec、ImplementationPlan。
2. 对信息不足的 issue，系统能进入 `NEEDS_INFO` 并提出明确问题。
3. maintainer 执行 `/approve-plan plan_id@plan_sha` 后，系统能创建工作分支并运行 Claude Code worker。
4. 旧 plan_sha 的审批命令无效。
5. 代码变更后系统能运行 fast gate，并在失败时进入有界修复循环。
6. 测试 job 无 GitHub 写 token、无 Anthropic key、无长期 secret。
7. 测试通过后系统能创建 PR，PR body 包含 issue、run_id、spec_id、plan_id、head_sha 和测试摘要。
8. PR 创建后系统能运行 code-reviewer 和 security-reviewer。
9. blocking finding 不会因新审查漏报而自动关闭。
10. 高风险 PR 在缺少人工 review 时不得合入。
11. PR synchronize 后旧测试、旧审查、旧审批全部失效。
12. 合入前 final evaluator 重新读取 GitHub 当前状态。
13. 合入后系统能关闭 issue、清理 label、写审计记录。
14. 所有状态迁移都能从 event log、artifact 和 audit chain 中追踪。
15. 重复 webhook 不产生重复 PR、重复评论或重复 agent run。
16. 系统自己写出的 comment/label 不触发业务循环。
17. 服务停机期间的 GitHub 变化可由 reconciler 恢复。
18. package script exfiltration、prompt injection、forbidden path escape 回归测试通过。

## 22. MVP 范围

MVP 必须完成：

```text
Webhook Gateway
Delivery deduplication
Origin suppression
PostgreSQL 状态机
SHA-bound workflow generation
Artifact Store with redaction
Event Bus
Issue Module
Command Authorization
Analysis Module
Plan Module
Claude Runner via GitHub Action
Trusted Control Runner / Untrusted Code Runner split
Filesystem sandbox baseline
Test Module fast gate
Package script exfiltration regression test
PR Module
Review Module basic code + security review
Manual merge gate
SHA-bound final evaluator baseline
Reconciler baseline
Audit log
Issue Intake Module（飞书 + WeCom）
  - 三层触发（显式 / 高 conf / 低 conf 多轮反问）
  - dedup（source_type|external_id|content_hash, 24h）
  - untrusted envelope
  - advisory classification（intake.issue.create_requested → Trusted Control Runner → issue.created → MOD-ISSUE）
  - prompt injection / sender spoofing / replay 回归测试
```

MVP 暂缓：

```text
多 worktree 并行
Agent SDK 自建 runner
自动 merge queue 入队
复杂成本优化 dashboard
多仓库批量任务
高级 UI dashboard
```

## 23. 关键工程约束

以下规则必须写入代码，不得只写进 prompt：

```text
所有用户内容均为不可信输入
最多 5 次 QA 修复循环
同类失败 3 次阻断
实现 agent 不能最终 approve
高风险路径不能自动合入
GitHub label/comment/PR body 不是内部状态源
所有事件幂等
所有 gate 绑定 SHA/hash
所有 prompt 和输出保存 artifact
所有 artifact 写入前脱敏
所有合入都有 policy decision record
合入前必须 final evaluation
测试 runner 不得携带写 token 或 secret
系统投影事件必须 origin suppression
reconciler 必须覆盖 active workflow runs
```
